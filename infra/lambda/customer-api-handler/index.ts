/**
 * Dewy Bank — Customer API handler.
 *
 * An API Gateway HTTP API with a Cognito JWT authorizer sits in front of this
 * Lambda. EVERY query is scoped server-side to the Cognito `sub` taken from the
 * VALIDATED JWT claims (event.requestContext.authorizer.jwt.claims.sub) —
 * caller-supplied ids are NEVER trusted for ownership. {id} path params are
 * ownership-checked against the caller's sub.
 *
 * The API makes no business decisions (Seven Factors, Factor II): it keeps who
 * the caller is and which accounts they can reach, and checks that a request is
 * well-formed. Limits, refusals and funds checks belong to the control plane
 * (the Workato recipe). See docs/backend-requirements.md (P2, P5, P6).
 *
 * Routes:
 *   GET  /me                             profile (customer record for sub)
 *   GET  /accounts                       caller's accounts (owner-index GSI on sub)
 *   GET  /accounts/{id}                  account detail (ownership-checked)
 *   GET  /accounts/{id}/transactions     transactions for an owned account
 *   POST /transfers {from,to,amount,memo?}          between caller-OWNED accounts only
 *   POST /payments {from,to_email,amount,memo?}     to another customer's checking (P5)
 *   GET  /statements/{id}                statement (ownership-checked via its account)
 *
 * Money is stored in integer CENTS to avoid float drift; the API speaks decimal
 * strings/numbers (dollars) at the edge.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "crypto";
import { parseMemo } from "../shared/memo";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const lambdaClient = new LambdaClient({});

const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE!;
const STATEMENTS_TABLE = process.env.STATEMENTS_TABLE!;
const PROVISIONING_FN = process.env.PROVISIONING_FN ?? "";
const PAYEES_TABLE = process.env.PAYEES_TABLE!;
const OWNER_INDEX = "owner-index";
const EMAIL_INDEX = "email-index";

type ApiEvent = {
  requestContext?: {
    http?: { method?: string; path?: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
  rawPath?: string;
  pathParameters?: Record<string, string>;
  body?: string | null;
  isBase64Encoded?: boolean;
};

type Resp = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

const json = (statusCode: number, obj: unknown): Resp => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});

/** cents (int) <-> dollars (number, 2dp) at the API edge. */
const toDollars = (cents: number): number => Math.round(cents) / 100;
const toCents = (dollars: number): number => Math.round(dollars * 100);

/** Shape an account record for the API (never leak internal-only fields). */
function viewAccount(a: Record<string, any>) {
  return {
    accountId: a.accountId,
    customerId: a.customerId,
    name: a.name ?? "Checking",
    type: a.type ?? "checking",
    currency: a.currency ?? "USD",
    balance: toDollars(a.balanceCents ?? 0),
  };
}

/** Shape a transaction row. `memo` is what the sender wrote; `channel` is which route wrote it (P2). */
function viewTxn(t: Record<string, any>) {
  return {
    txnId: t.txnId,
    accountId: t.accountId,
    type: t.type,
    amount: toDollars(t.amountCents ?? 0),
    counterparty: t.counterparty ?? null,
    memo: t.memo ?? null,
    channel: t.channel ?? null,
    category: t.category ?? null,
    createdAt: t.createdAt ?? null,
  };
}

export const handler = async (event: ApiEvent): Promise<Resp> => {
  const method = event.requestContext?.http?.method ?? "GET";
  const rawPath = event.requestContext?.http?.path ?? event.rawPath ?? "/";
  // Normalise any API Gateway stage prefix away; we match on the trailing path.
  const path = rawPath.replace(/\/+$/, "") || "/";

  // The JWT authorizer has already validated the token; `sub` is trustworthy.
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const sub = claims.sub as string | undefined;
  if (!sub) {
    return json(401, { message: "Unauthorized: missing JWT sub claim" });
  }
  // `cognito:groups` is a validated claim; membership in `facilitators` is what
  // gates the /admin/* routes below. The claim arrives either as a JSON array
  // or a bracketed string depending on the API Gateway serialization.
  const isFacilitator = parseGroups(claims["cognito:groups"]).includes(
    "facilitators",
  );

  try {
    // GET /me
    if (method === "GET" && path === "/me") {
      const r = await ddb.send(
        new GetCommand({
          TableName: CUSTOMERS_TABLE,
          Key: { customerId: sub },
        }),
      );
      if (!r.Item) return json(404, { message: "Customer not found" });
      return json(200, {
        customerId: r.Item.customerId,
        email: r.Item.email ?? null,
        createdAt: r.Item.createdAt ?? null,
      });
    }

    // GET /accounts  — caller's accounts via owner-index GSI
    if (method === "GET" && path === "/accounts") {
      const accounts = await listOwnedAccounts(sub);
      return json(200, { accounts: accounts.map(viewAccount) });
    }

    // GET /accounts/{id}
    let m = path.match(/^\/accounts\/([^/]+)$/);
    if (method === "GET" && m) {
      const acct = await getOwnedAccount(m[1], sub);
      if (!acct) return json(404, { message: "Account not found" });
      return json(200, viewAccount(acct));
    }

    // GET /accounts/{id}/transactions
    m = path.match(/^\/accounts\/([^/]+)\/transactions$/);
    if (method === "GET" && m) {
      const acct = await getOwnedAccount(m[1], sub);
      if (!acct) return json(404, { message: "Account not found" });
      return json(200, { transactions: await listTransactions(m[1]) });
    }

    // GET /payees — list the caller's saved payees, newest first (P11).
    if (method === "GET" && path === "/payees") {
      const r = await ddb.send(
        new QueryCommand({
          TableName: PAYEES_TABLE,
          KeyConditionExpression: "customerId = :c",
          ExpressionAttributeValues: { ":c": sub },
        }),
      );
      const payees = (r.Items ?? [])
        .map((item) => ({ email: item.email, addedAt: item.addedAt }))
        .sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""));
      return json(200, { payees });
    }

    // POST /payees {email} — add a payee. Email must belong to a Dewy Bank
    // customer. Re-adding an existing payee returns 200 (idempotent).
    if (method === "POST" && path === "/payees") {
      const body = parseBody(event);
      const email = String(body.email ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(400, {
          message: "email is required and must be a valid address",
        });
      }
      const customer = await findCustomerByEmail(email);
      if (!customer)
        return json(404, { message: "No Dewy Bank customer with that email" });
      const existing = await ddb.send(
        new GetCommand({
          TableName: PAYEES_TABLE,
          Key: { customerId: sub, email },
        }),
      );
      if (existing.Item) {
        return json(200, {
          email: existing.Item.email,
          addedAt: existing.Item.addedAt,
        });
      }
      const addedAt = new Date().toISOString();
      await ddb.send(
        new PutCommand({
          TableName: PAYEES_TABLE,
          Item: { customerId: sub, email, addedAt },
        }),
      );
      return json(201, { email, addedAt });
    }

    // DELETE /payees/{email} — remove a payee.
    m = path.match(/^\/payees\/([^/]+)$/);
    if (method === "DELETE" && m) {
      const email = decodeURIComponent(m[1]);
      const existing = await ddb.send(
        new GetCommand({
          TableName: PAYEES_TABLE,
          Key: { customerId: sub, email },
        }),
      );
      if (!existing.Item) return json(404, { message: "Payee not found" });
      await ddb.send(
        new DeleteCommand({
          TableName: PAYEES_TABLE,
          Key: { customerId: sub, email },
        }),
      );
      return {
        statusCode: 204,
        headers: { "content-type": "application/json" },
        body: "",
      };
    }

    // POST /transfers {from,to,amount,memo?} — between caller-OWNED accounts only.
    // No amount, same-account or funds checks (P6): those are the recipe's rules.
    if (method === "POST" && path === "/transfers") {
      const body = parseBody(event);
      const from = String(body.from ?? "");
      const to = String(body.to ?? "");
      const amount = Number(body.amount);
      if (!from || !to || !Number.isFinite(amount)) {
        return json(400, {
          message: "from, to and a numeric amount are required",
        });
      }
      const memo = parseMemo(body.memo);
      if (!memo.ok) return json(400, { message: memo.message });

      // OWNERSHIP: both accounts must belong to the caller's sub. That's scope,
      // not a business rule, so the API keeps it.
      const [src, dst] = await Promise.all([
        getOwnedAccount(from, sub),
        getOwnedAccount(to, sub),
      ]);
      if (!src || !dst) {
        return json(403, {
          message: "Both accounts must be owned by the caller",
        });
      }
      const cents = toCents(amount);
      await moveFunds({
        from,
        to,
        cents,
        channel: "customer-transfer",
        memo: memo.memo,
      });
      return json(200, {
        message: "Transfer complete",
        from,
        to,
        amount: toDollars(cents),
      });
    }

    // POST /payments {from,to_email,amount,memo?} — pay another customer (P5).
    // The money lands in the recipient's checking. No business checks: no
    // positive-amount, funds, limit, payee or confirmation rules. A negative
    // amount moves money the other way; that's deliberate (P5, "Negative
    // amounts"): a caller who skips the control plane gets no rules at all.
    if (method === "POST" && path === "/payments") {
      const body = parseBody(event);
      const from = String(body.from ?? "");
      const toEmail = String(body.to_email ?? "").trim();
      const amount = Number(body.amount);
      if (!from || !toEmail || !Number.isFinite(amount)) {
        return json(400, {
          message: "from, to_email and a numeric amount are required",
        });
      }
      const memo = parseMemo(body.memo);
      if (!memo.ok) return json(400, { message: memo.message });

      const src = await getOwnedAccount(from, sub);
      if (!src)
        return json(403, {
          message: "You can only pay from your own accounts",
        });

      const recipient = await findCustomerByEmail(toEmail);
      if (!recipient) return json(404, { message: "Customer not found" });
      const recipientAccounts = await listOwnedAccounts(recipient.customerId);
      const checking = recipientAccounts.find((a) => a.type === "checking");
      if (!checking)
        return json(404, { message: "Customer has no checking account" });

      const payerEmail =
        (claims.email as string | undefined) ??
        (await getCustomerEmail(sub)) ??
        sub;
      const cents = toCents(amount);
      await moveFunds({
        from,
        to: checking.accountId,
        cents,
        channel: "customer-payment",
        memo: memo.memo,
        debitCounterparty: recipient.email,
        creditCounterparty: payerEmail,
      });
      return json(200, {
        message: "Payment sent",
        from,
        to_email: recipient.email,
        amount: toDollars(cents),
      });
    }

    // GET /statements/{id}  — ownership checked via the statement's account
    m = path.match(/^\/statements\/([^/]+)$/);
    if (method === "GET" && m) {
      // Statement id is scoped under an account (accountId PK, statementId SK);
      // we resolve by scanning the caller's accounts for a matching statement.
      const accounts = await listOwnedAccounts(sub);
      for (const acct of accounts) {
        const r = await ddb.send(
          new GetCommand({
            TableName: STATEMENTS_TABLE,
            Key: { accountId: acct.accountId, statementId: m[1] },
          }),
        );
        if (r.Item) {
          return json(200, {
            statementId: r.Item.statementId,
            accountId: r.Item.accountId,
            period: r.Item.period ?? null,
            openingBalance: toDollars(r.Item.openingBalanceCents ?? 0),
            closingBalance: toDollars(r.Item.closingBalanceCents ?? 0),
            url: r.Item.url ?? null,
          });
        }
      }
      return json(404, { message: "Statement not found" });
    }

    // =====================================================================
    // ADMIN / FACILITATOR routes — gated by the `facilitators` Cognito group.
    // These power the admin console UI. Auth is the SAME Cognito JWT (no static
    // API key in the browser); the group claim is the authorization boundary.
    // =====================================================================
    if (path.startsWith("/admin/")) {
      if (!isFacilitator) {
        return json(403, { message: "Forbidden: facilitators group required" });
      }

      // GET /admin/overview — aggregate stats across ALL customers/accounts.
      if (method === "GET" && path === "/admin/overview") {
        const accounts = await scanAllAccounts();
        const customerIds = new Set(
          accounts.map((a) => a.customerId).filter(Boolean),
        );
        const totalCents = accounts.reduce(
          (s, a) => s + (a.balanceCents ?? 0),
          0,
        );
        return json(200, {
          customers: customerIds.size,
          accounts: accounts.length,
          totalBalance: toDollars(totalCents),
        });
      }

      // GET /admin/accounts — every account across every customer.
      if (method === "GET" && path === "/admin/accounts") {
        const accounts = await scanAllAccounts();
        // Group by customer so the console can render per-customer sections.
        const customers = await scanAllCustomers();
        const emailBySub: Record<string, string> = {};
        for (const c of customers) emailBySub[c.customerId] = c.email ?? "";
        const view = accounts
          // `fictional` lets the console badge the C-P4 customers.
          .map((a) => ({
            ...viewAccount(a),
            email: emailBySub[a.customerId] ?? null,
            fictional: a.fictional === true,
          }))
          .sort((x, y) => (x.email ?? "").localeCompare(y.email ?? ""));
        return json(200, { accounts: view });
      }

      // GET /admin/accounts/{id}/transactions — any account's history.
      let am = path.match(/^\/admin\/accounts\/([^/]+)\/transactions$/);
      if (method === "GET" && am) {
        return json(200, { transactions: await listTransactions(am[1]) });
      }

      // POST /admin/adjust-balance {id, amount} — mint/seed/reset (delta in $).
      if (method === "POST" && path === "/admin/adjust-balance") {
        const b = parseBody(event);
        const id = String(b.id ?? "");
        const amount = Number(b.amount); // may be negative
        if (!id || !Number.isFinite(amount)) {
          return json(400, { message: "id and a numeric amount are required" });
        }
        const r = await ddb.send(
          new UpdateCommand({
            TableName: ACCOUNTS_TABLE,
            Key: { accountId: id },
            UpdateExpression:
              "SET balanceCents = if_not_exists(balanceCents, :z) + :amt",
            ConditionExpression: "attribute_exists(accountId)",
            ExpressionAttributeValues: { ":amt": toCents(amount), ":z": 0 },
            ReturnValues: "ALL_NEW",
          }),
        );
        return json(200, {
          message: "Balance adjusted",
          accountId: id,
          balance: toDollars(r.Attributes?.balanceCents ?? 0),
        });
      }

      // POST /admin/set-balance {id, balance} — set an account to an exact $.
      if (method === "POST" && path === "/admin/set-balance") {
        const b = parseBody(event);
        const id = String(b.id ?? "");
        const balance = Number(b.balance);
        if (!id || !Number.isFinite(balance)) {
          return json(400, {
            message: "id and a numeric balance are required",
          });
        }
        const r = await ddb.send(
          new UpdateCommand({
            TableName: ACCOUNTS_TABLE,
            Key: { accountId: id },
            UpdateExpression: "SET balanceCents = :b",
            ConditionExpression: "attribute_exists(accountId)",
            ExpressionAttributeValues: { ":b": toCents(balance) },
            ReturnValues: "ALL_NEW",
          }),
        );
        return json(200, {
          message: "Balance set",
          accountId: id,
          balance: toDollars(r.Attributes?.balanceCents ?? 0),
        });
      }

      // POST /admin/transfer {from,to,amount,memo?} — facilitator-driven raw
      // transfer: the live vector for a poisoned memo (P2). The facilitator's
      // own tool keeps its sanity checks; it isn't a station's control plane.
      if (method === "POST" && path === "/admin/transfer") {
        const b = parseBody(event);
        const from = String(b.from ?? "");
        const to = String(b.to ?? "");
        const amount = Number(b.amount);
        if (!from || !to || !Number.isFinite(amount) || amount <= 0) {
          return json(400, {
            message: "from, to and a positive amount are required",
          });
        }
        if (from === to)
          return json(400, { message: "from and to must differ" });
        const memo = parseMemo(b.memo);
        if (!memo.ok) return json(400, { message: memo.message });
        await moveFunds({
          from,
          to,
          cents: toCents(amount),
          channel: "admin-console-transfer",
          memo: memo.memo,
        });
        return json(200, { message: "Transfer complete", from, to, amount });
      }

      // POST /admin/reseed {email?} — reset the whole workshop, or one
      // participant (P10). Runs in the provisioning Lambda, asynchronously,
      // so a big room doesn't hit the API's 30-second limit.
      if (method === "POST" && path === "/admin/reseed") {
        const b = parseBody(event);
        const email =
          b.email === undefined || b.email === null
            ? undefined
            : String(b.email).trim();
        if (email !== undefined && !email)
          return json(400, { message: "email, if given, must not be empty" });
        if (!PROVISIONING_FN)
          return json(500, { message: "Provisioning function not configured" });
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: PROVISIONING_FN,
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify({ action: "reseed", email })),
          }),
        );
        return json(202, {
          message: "Reset started",
          scope: email ?? "workshop",
        });
      }

      return json(404, { message: `No admin route for ${method} ${path}` });
    }

    return json(404, { message: `No route for ${method} ${path}` });
  } catch (err: any) {
    console.error("customer-api-handler error", err);
    if (err?.name === "TransactionCanceledException") {
      return json(409, {
        message: "Transfer could not be completed (balance changed)",
      });
    }
    return json(500, { message: "Internal error" });
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBody(event: ApiEvent): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function listOwnedAccounts(sub: string): Promise<Record<string, any>[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      IndexName: OWNER_INDEX,
      KeyConditionExpression: "customerId = :c",
      ExpressionAttributeValues: { ":c": sub },
    }),
  );
  return r.Items ?? [];
}

async function listTransactions(accountId: string) {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TRANSACTIONS_TABLE,
      KeyConditionExpression: "accountId = :a",
      ExpressionAttributeValues: { ":a": accountId },
      ScanIndexForward: false,
      Limit: 100,
    }),
  );
  return (r.Items ?? []).map(viewTxn);
}

/**
 * Find a customer by email (C-P1), via the email-index GSI. Tries the email as
 * given, then lower-cased, since Cognito keeps the case the customer typed.
 */
async function findCustomerByEmail(
  email: string,
): Promise<Record<string, any> | null> {
  for (const candidate of new Set([email, email.toLowerCase()])) {
    const r = await ddb.send(
      new QueryCommand({
        TableName: CUSTOMERS_TABLE,
        IndexName: EMAIL_INDEX,
        KeyConditionExpression: "email = :e",
        ExpressionAttributeValues: { ":e": candidate },
        Limit: 1,
      }),
    );
    if (r.Items?.[0]) return r.Items[0];
  }
  return null;
}

async function getCustomerEmail(sub: string): Promise<string | undefined> {
  const r = await ddb.send(
    new GetCommand({ TableName: CUSTOMERS_TABLE, Key: { customerId: sub } }),
  );
  return r.Item?.email;
}

/**
 * Normalise the `cognito:groups` claim into a string[]. API Gateway may deliver
 * it as a real JSON array, or as a bracketed, space/comma-separated string like
 * "[facilitators]" depending on the HTTP API's claim serialization.
 */
function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    return raw
      .replace(/^\[|\]$/g, "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

async function scanAllAccounts(): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const r: any = await ddb.send(
      new ScanCommand({ TableName: ACCOUNTS_TABLE, ExclusiveStartKey }),
    );
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function scanAllCustomers(): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const r: any = await ddb.send(
      new ScanCommand({ TableName: CUSTOMERS_TABLE, ExclusiveStartKey }),
    );
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** Fetch an account only if the caller owns it; otherwise null. */
async function getOwnedAccount(
  accountId: string,
  sub: string,
): Promise<Record<string, any> | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { accountId } }),
  );
  if (!r.Item || r.Item.customerId !== sub) return null;
  return r.Item;
}

type Move = {
  from: string;
  to: string;
  cents: number;
  /** Which route wrote the rows (audit data, P2). */
  channel: string;
  /** What the sender wrote, stored exactly as sent (P2). */
  memo?: string;
  /** Shown on each row as the other side; defaults to the other account's id. */
  debitCounterparty?: string;
  creditCounterparty?: string;
};

/**
 * Atomically move `cents` from one account to another and write both txn
 * legs, in a single DynamoDB transaction. There's no balance guard (P6): the
 * amount is applied as given, including a negative one.
 *
 * A same-account move (from === to) writes both rows and leaves the balance
 * unchanged: DynamoDB can't update one item twice in a transaction, and the
 * net change is zero anyway.
 */
async function moveFunds(mv: Move): Promise<void> {
  const now = new Date().toISOString();
  const debitId = randomUUID();
  const creditId = randomUUID();
  const row = (
    accountId: string,
    id: string,
    type: "debit" | "credit",
    counterparty: string,
  ) => ({
    Put: {
      TableName: TRANSACTIONS_TABLE,
      Item: {
        accountId,
        txnId: `${now}#${id}`,
        type,
        amountCents: mv.cents,
        counterparty,
        memo: mv.memo,
        channel: mv.channel,
        createdAt: now,
      },
    },
  });
  const balanceUpdates =
    mv.from === mv.to
      ? []
      : [
          {
            Update: {
              TableName: ACCOUNTS_TABLE,
              Key: { accountId: mv.from },
              UpdateExpression: "SET balanceCents = balanceCents - :amt",
              ExpressionAttributeValues: { ":amt": mv.cents },
            },
          },
          {
            Update: {
              TableName: ACCOUNTS_TABLE,
              Key: { accountId: mv.to },
              UpdateExpression: "SET balanceCents = balanceCents + :amt",
              ExpressionAttributeValues: { ":amt": mv.cents },
            },
          },
        ];
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        ...balanceUpdates,
        row(mv.from, debitId, "debit", mv.debitCounterparty ?? mv.to),
        row(mv.to, creditId, "credit", mv.creditCounterparty ?? mv.from),
      ],
    }),
  );
}
