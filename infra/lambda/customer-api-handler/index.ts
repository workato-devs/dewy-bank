/**
 * Dewy Bank — Customer API handler (Phase 1).
 *
 * The HONEST, non-vulnerable path: an API Gateway HTTP API with a Cognito JWT
 * authorizer sits in front of this Lambda. EVERY query is scoped server-side to
 * the Cognito `sub` taken from the VALIDATED JWT claims (event.requestContext.
 * authorizer.jwt.claims.sub) — caller-supplied ids are NEVER trusted for
 * ownership. {id} path params are ownership-checked against the caller's sub.
 *
 * Routes:
 *   GET  /me                             profile (customer record for sub)
 *   GET  /accounts                       caller's accounts (owner-index GSI on sub)
 *   GET  /accounts/{id}                  account detail (ownership-checked)
 *   GET  /accounts/{id}/transactions     transactions for an owned account
 *   POST /transfers {from,to,amount}     transfer between caller-OWNED accounts only
 *   GET  /statements/{id}                statement (ownership-checked via its account)
 *
 * Money is stored in integer CENTS to avoid float drift; the API speaks decimal
 * strings/numbers (dollars) at the edge.
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE!;
const STATEMENTS_TABLE = process.env.STATEMENTS_TABLE!;
const OWNER_INDEX = 'owner-index';

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

type Resp = { statusCode: number; headers: Record<string, string>; body: string };

const json = (statusCode: number, obj: unknown): Resp => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
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
    name: a.name ?? 'Checking',
    type: a.type ?? 'checking',
    currency: a.currency ?? 'USD',
    balance: toDollars(a.balanceCents ?? 0),
  };
}

export const handler = async (event: ApiEvent): Promise<Resp> => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.requestContext?.http?.path ?? event.rawPath ?? '/';
  // Normalise any API Gateway stage prefix away; we match on the trailing path.
  const path = rawPath.replace(/\/+$/, '') || '/';

  // The JWT authorizer has already validated the token; `sub` is trustworthy.
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const sub = claims.sub as string | undefined;
  if (!sub) {
    return json(401, { message: 'Unauthorized: missing JWT sub claim' });
  }
  // `cognito:groups` is a validated claim; membership in `facilitators` is what
  // gates the /admin/* routes below. The claim arrives either as a JSON array
  // or a bracketed string depending on the API Gateway serialization.
  const isFacilitator = parseGroups(claims['cognito:groups']).includes('facilitators');

  try {
    // GET /me
    if (method === 'GET' && path === '/me') {
      const r = await ddb.send(
        new GetCommand({ TableName: CUSTOMERS_TABLE, Key: { customerId: sub } }),
      );
      if (!r.Item) return json(404, { message: 'Customer not found' });
      return json(200, {
        customerId: r.Item.customerId,
        email: r.Item.email ?? null,
        createdAt: r.Item.createdAt ?? null,
      });
    }

    // GET /accounts  — caller's accounts via owner-index GSI
    if (method === 'GET' && path === '/accounts') {
      const accounts = await listOwnedAccounts(sub);
      return json(200, { accounts: accounts.map(viewAccount) });
    }

    // GET /accounts/{id}
    let m = path.match(/^\/accounts\/([^/]+)$/);
    if (method === 'GET' && m) {
      const acct = await getOwnedAccount(m[1], sub);
      if (!acct) return json(404, { message: 'Account not found' });
      return json(200, viewAccount(acct));
    }

    // GET /accounts/{id}/transactions
    m = path.match(/^\/accounts\/([^/]+)\/transactions$/);
    if (method === 'GET' && m) {
      const acct = await getOwnedAccount(m[1], sub);
      if (!acct) return json(404, { message: 'Account not found' });
      const r = await ddb.send(
        new QueryCommand({
          TableName: TRANSACTIONS_TABLE,
          KeyConditionExpression: 'accountId = :a',
          ExpressionAttributeValues: { ':a': m[1] },
          ScanIndexForward: false,
          Limit: 100,
        }),
      );
      const txns = (r.Items ?? []).map((t) => ({
        txnId: t.txnId,
        accountId: t.accountId,
        type: t.type,
        amount: toDollars(t.amountCents ?? 0),
        counterparty: t.counterparty ?? null,
        memo: t.memo ?? null,
        category: t.category ?? null,
        createdAt: t.createdAt ?? null,
      }));
      return json(200, { transactions: txns });
    }

    // POST /transfers {from,to,amount} — between caller-OWNED accounts only
    if (method === 'POST' && path === '/transfers') {
      const body = parseBody(event);
      const from = String(body.from ?? '');
      const to = String(body.to ?? '');
      const amount = Number(body.amount);
      if (!from || !to || !Number.isFinite(amount) || amount <= 0) {
        return json(400, { message: 'from, to and a positive amount are required' });
      }
      if (from === to) return json(400, { message: 'from and to must differ' });

      // OWNERSHIP: both accounts must belong to the caller's sub.
      const [src, dst] = await Promise.all([
        getOwnedAccount(from, sub),
        getOwnedAccount(to, sub),
      ]);
      if (!src || !dst) {
        return json(403, { message: 'Both accounts must be owned by the caller' });
      }
      const cents = toCents(amount);
      if ((src.balanceCents ?? 0) < cents) {
        return json(422, { message: 'Insufficient funds' });
      }
      await moveFunds(from, to, cents, 'customer-transfer');
      return json(200, {
        message: 'Transfer complete',
        from,
        to,
        amount: toDollars(cents),
      });
    }

    // GET /statements/{id}  — ownership checked via the statement's account
    m = path.match(/^\/statements\/([^/]+)$/);
    if (method === 'GET' && m) {
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
      return json(404, { message: 'Statement not found' });
    }

    // =====================================================================
    // ADMIN / FACILITATOR routes — gated by the `facilitators` Cognito group.
    // These power the admin console UI. Auth is the SAME Cognito JWT (no static
    // API key in the browser); the group claim is the authorization boundary.
    // This is the HONEST, authenticated admin surface — distinct from the
    // intentionally-insecure x-api-key Admin API consumed by Workato.
    // =====================================================================
    if (path.startsWith('/admin/')) {
      if (!isFacilitator) {
        return json(403, { message: 'Forbidden: facilitators group required' });
      }

      // GET /admin/overview — aggregate stats across ALL customers/accounts.
      if (method === 'GET' && path === '/admin/overview') {
        const accounts = await scanAllAccounts();
        const customerIds = new Set(accounts.map((a) => a.customerId).filter(Boolean));
        const totalCents = accounts.reduce((s, a) => s + (a.balanceCents ?? 0), 0);
        return json(200, {
          customers: customerIds.size,
          accounts: accounts.length,
          totalBalance: toDollars(totalCents),
        });
      }

      // GET /admin/accounts — every account across every customer.
      if (method === 'GET' && path === '/admin/accounts') {
        const accounts = await scanAllAccounts();
        // Group by customer so the console can render per-customer sections.
        const customers = await scanAllCustomers();
        const emailBySub: Record<string, string> = {};
        for (const c of customers) emailBySub[c.customerId] = c.email ?? '';
        const view = accounts
          .map((a) => ({ ...viewAccount(a), email: emailBySub[a.customerId] ?? null }))
          .sort((x, y) => (x.email ?? '').localeCompare(y.email ?? ''));
        return json(200, { accounts: view });
      }

      // GET /admin/accounts/{id}/transactions — any account's history.
      let am = path.match(/^\/admin\/accounts\/([^/]+)\/transactions$/);
      if (method === 'GET' && am) {
        const r = await ddb.send(
          new QueryCommand({
            TableName: TRANSACTIONS_TABLE,
            KeyConditionExpression: 'accountId = :a',
            ExpressionAttributeValues: { ':a': am[1] },
            ScanIndexForward: false,
            Limit: 100,
          }),
        );
        const txns = (r.Items ?? []).map((t) => ({
          txnId: t.txnId,
          type: t.type,
          amount: toDollars(t.amountCents ?? 0),
          counterparty: t.counterparty ?? null,
          memo: t.memo ?? null,
          category: t.category ?? null,
          createdAt: t.createdAt ?? null,
        }));
        return json(200, { transactions: txns });
      }

      // POST /admin/adjust-balance {id, amount} — mint/seed/reset (delta in $).
      if (method === 'POST' && path === '/admin/adjust-balance') {
        const b = parseBody(event);
        const id = String(b.id ?? '');
        const amount = Number(b.amount); // may be negative
        if (!id || !Number.isFinite(amount)) {
          return json(400, { message: 'id and a numeric amount are required' });
        }
        const r = await ddb.send(
          new UpdateCommand({
            TableName: ACCOUNTS_TABLE,
            Key: { accountId: id },
            UpdateExpression: 'SET balanceCents = if_not_exists(balanceCents, :z) + :amt',
            ConditionExpression: 'attribute_exists(accountId)',
            ExpressionAttributeValues: { ':amt': toCents(amount), ':z': 0 },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return json(200, {
          message: 'Balance adjusted',
          accountId: id,
          balance: toDollars(r.Attributes?.balanceCents ?? 0),
        });
      }

      // POST /admin/set-balance {id, balance} — set an account to an exact $.
      if (method === 'POST' && path === '/admin/set-balance') {
        const b = parseBody(event);
        const id = String(b.id ?? '');
        const balance = Number(b.balance);
        if (!id || !Number.isFinite(balance)) {
          return json(400, { message: 'id and a numeric balance are required' });
        }
        const r = await ddb.send(
          new UpdateCommand({
            TableName: ACCOUNTS_TABLE,
            Key: { accountId: id },
            UpdateExpression: 'SET balanceCents = :b',
            ConditionExpression: 'attribute_exists(accountId)',
            ExpressionAttributeValues: { ':b': toCents(balance) },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return json(200, {
          message: 'Balance set',
          accountId: id,
          balance: toDollars(r.Attributes?.balanceCents ?? 0),
        });
      }

      // POST /admin/transfer {from,to,amount} — facilitator-driven raw transfer.
      if (method === 'POST' && path === '/admin/transfer') {
        const b = parseBody(event);
        const from = String(b.from ?? '');
        const to = String(b.to ?? '');
        const amount = Number(b.amount);
        if (!from || !to || !Number.isFinite(amount) || amount <= 0) {
          return json(400, { message: 'from, to and a positive amount are required' });
        }
        if (from === to) return json(400, { message: 'from and to must differ' });
        await moveFunds(from, to, toCents(amount), 'admin-console-transfer');
        return json(200, { message: 'Transfer complete', from, to, amount });
      }

      return json(404, { message: `No admin route for ${method} ${path}` });
    }

    return json(404, { message: `No route for ${method} ${path}` });
  } catch (err: any) {
    console.error('customer-api-handler error', err);
    if (err?.name === 'TransactionCanceledException') {
      return json(409, { message: 'Transfer could not be completed (balance changed)' });
    }
    return json(500, { message: 'Internal error' });
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBody(event: ApiEvent): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
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
      KeyConditionExpression: 'customerId = :c',
      ExpressionAttributeValues: { ':c': sub },
    }),
  );
  return r.Items ?? [];
}

/**
 * Normalise the `cognito:groups` claim into a string[]. API Gateway may deliver
 * it as a real JSON array, or as a bracketed, space/comma-separated string like
 * "[facilitators]" depending on the HTTP API's claim serialization.
 */
function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    return raw
      .replace(/^\[|\]$/g, '')
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

/**
 * Atomically move `cents` from one account to another and write both txn legs,
 * using a single DynamoDB transaction with a balance guard on the source.
 */
async function moveFunds(
  from: string,
  to: string,
  cents: number,
  kind: string,
): Promise<void> {
  const now = new Date().toISOString();
  const debitId = randomUUID();
  const creditId = randomUUID();
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: ACCOUNTS_TABLE,
            Key: { accountId: from },
            UpdateExpression: 'SET balanceCents = balanceCents - :amt',
            ConditionExpression: 'balanceCents >= :amt',
            ExpressionAttributeValues: { ':amt': cents },
          },
        },
        {
          Update: {
            TableName: ACCOUNTS_TABLE,
            Key: { accountId: to },
            UpdateExpression: 'SET balanceCents = balanceCents + :amt',
            ExpressionAttributeValues: { ':amt': cents },
          },
        },
        {
          Put: {
            TableName: TRANSACTIONS_TABLE,
            Item: {
              accountId: from,
              txnId: `${now}#${debitId}`,
              type: 'debit',
              amountCents: cents,
              counterparty: to,
              memo: kind,
              createdAt: now,
            },
          },
        },
        {
          Put: {
            TableName: TRANSACTIONS_TABLE,
            Item: {
              accountId: to,
              txnId: `${now}#${creditId}`,
              type: 'credit',
              amountCents: cents,
              counterparty: from,
              memo: kind,
              createdAt: now,
            },
          },
        },
      ],
    }),
  );
}
