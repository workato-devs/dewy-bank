/**
 * Dewy Bank — Provisioning Lambda (P10).
 *
 * Facilitator-run workshop setup and reset. Invoked asynchronously by the
 * customer API's facilitator route `POST /admin/reseed`, or directly through IAM.
 *
 *   {action: 'setup'}                creates or restores the fictional customers (C-P4)
 *   {action: 'reseed'}               resets every participant to the shared seed, and
 *                                    restores the fictional customers
 *   {action: 'reseed', email: <e>}   resets one participant
 *   {action: 'teardown'}             not implemented yet
 *
 * "Reset" means: the participant's accounts get the SEED_ACCOUNTS balances, and
 * their history becomes exactly SEED_TXNS (including the P2b row); every other
 * transaction (payments, transfers, adjustments) is deleted. The seed data is
 * ../shared/seed, shared with the sign-up trigger so the two can't drift apart.
 * Every step is idempotent, so a reset can be re-run safely.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  FACILITATOR_SEED_CUSTOMER,
  FICTIONAL_CUSTOMERS,
  SEED_ACCOUNTS,
  SEED_TXNS,
  accountIdFor,
  isoDaysAgo,
  seedTxnId,
} from "../shared/seed";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE!;
const PAYEES_TABLE = process.env.PAYEES_TABLE ?? "";
const OWNER_INDEX = "owner-index";
const EMAIL_INDEX = "email-index";

type ProvisioningEvent = {
  action?: "setup" | "teardown" | "reseed";
  email?: string;
  [k: string]: unknown;
};

type Result = {
  status: string;
  message: string;
  participants?: number;
  fictional?: number;
};

export const handler = async (event: ProvisioningEvent): Promise<Result> => {
  console.log(
    "provisioning",
    JSON.stringify({ action: event.action, email: event.email }),
  );
  const now = Date.now();

  switch (event.action) {
    case "setup": {
      await restoreFictionalCustomers(now);
      return {
        status: "ok",
        message: "Fictional customers ready",
        fictional: FICTIONAL_CUSTOMERS.length,
      };
    }

    case "reseed": {
      if (event.email) {
        const customer = await findCustomerByEmail(event.email);
        if (!customer || customer.fictional === true) {
          return {
            status: "not-found",
            message: `No participant with email ${event.email}`,
          };
        }
        await reseedParticipant(customer.customerId, now);
        return {
          status: "ok",
          message: `Reset ${event.email}`,
          participants: 1,
        };
      }
      const customers = await scanAll(CUSTOMERS_TABLE);
      const participants = customers.filter((c) => c.fictional !== true);
      for (const c of participants) await reseedParticipant(c.customerId, now);
      await restoreFictionalCustomers(now);
      return {
        status: "ok",
        message: "Reset the workshop",
        participants: participants.length,
        fictional: FICTIONAL_CUSTOMERS.length,
      };
    }

    case "teardown":
      return {
        status: "not-implemented",
        message: "teardown is not implemented yet",
      };

    default:
      return {
        status: "error",
        message: `Unknown action ${String(event.action)}`, // noboost
      };
  }
};

/** Restore one participant to the shared seed: balances and history. */
async function reseedParticipant(
  customerId: string,
  now: number,
): Promise<void> {
  await deleteHistory(customerId);
  // P11: clear this participant's saved payees.
  if (PAYEES_TABLE) {
    const payees = await queryAll({
      TableName: PAYEES_TABLE,
      KeyConditionExpression: "customerId = :c",
      ExpressionAttributeValues: { ":c": customerId },
      ProjectionExpression: "customerId, email",
    });
    await batchWrite(
      PAYEES_TABLE,
      payees.map((p) => ({
        DeleteRequest: { Key: { customerId: p.customerId, email: p.email } },
      })),
    );
  }
  const createdAt = new Date(now).toISOString();
  await batchPut(
    ACCOUNTS_TABLE,
    SEED_ACCOUNTS.map((def) => ({
      accountId: accountIdFor(customerId, def.suffix),
      customerId, // owner-index GSI partition key
      name: def.name,
      type: def.type,
      currency: def.currency,
      balanceCents: def.balanceCents,
      createdAt,
    })),
  );
  await batchPut(
    TRANSACTIONS_TABLE,
    SEED_TXNS.map((t, i) => {
      const at = isoDaysAgo(t.daysAgo, now);
      return {
        accountId: accountIdFor(customerId, t.acct),
        txnId: seedTxnId(at, i),
        type: t.type,
        amountCents: t.amountCents,
        counterparty: t.counterparty,
        memo: t.memo,
        category: t.category,
        channel: t.channel ?? "seed",
        createdAt: at,
      };
    }),
  );
}

/** Create or restore the fictional customers (C-P4): exact balances, no history. */
async function restoreFictionalCustomers(now: number): Promise<void> {
  const createdAt = new Date(now).toISOString();
  for (const c of FICTIONAL_CUSTOMERS) {
    await deleteHistory(c.customerId);
    await batchPut(CUSTOMERS_TABLE, [
      {
        customerId: c.customerId,
        email: c.email,
        name: c.name,
        fictional: true,
        createdAt,
      },
    ]);
    await batchPut(
      ACCOUNTS_TABLE,
      c.accounts.map((a) => ({
        accountId: accountIdFor(c.customerId, a.suffix),
        customerId: c.customerId,
        name: a.name,
        type: a.type,
        currency: "USD",
        balanceCents: a.balanceCents,
        fictional: true,
        createdAt,
      })),
    );
  }

  // Seed the workshop facilitator customer (P11): exists so participants can
  // add facilitator@dewybank.example as a payee. Marked fictional so resets
  // don't treat this record as a participant.
  const fc = FACILITATOR_SEED_CUSTOMER;
  await batchPut(CUSTOMERS_TABLE, [
    {
      customerId: fc.customerId,
      email: fc.email,
      name: fc.name,
      fictional: true,
      createdAt,
    },
  ]);
  await batchPut(ACCOUNTS_TABLE, [
    {
      accountId: accountIdFor(fc.customerId, "checking"),
      customerId: fc.customerId,
      name: "Everyday Checking",
      type: "checking",
      currency: "USD",
      balanceCents: 0,
      fictional: true,
      createdAt,
    },
  ]);
}

/** Delete every transaction on every account a customer owns. */
async function deleteHistory(customerId: string): Promise<void> {
  const accounts = await queryAll({
    TableName: ACCOUNTS_TABLE,
    IndexName: OWNER_INDEX,
    KeyConditionExpression: "customerId = :c",
    ExpressionAttributeValues: { ":c": customerId },
  });
  for (const a of accounts) {
    const txns = await queryAll({
      TableName: TRANSACTIONS_TABLE,
      KeyConditionExpression: "accountId = :a",
      ExpressionAttributeValues: { ":a": a.accountId },
      ProjectionExpression: "accountId, txnId",
    });
    await batchWrite(
      TRANSACTIONS_TABLE,
      txns.map((t) => ({
        DeleteRequest: { Key: { accountId: t.accountId, txnId: t.txnId } },
      })),
    );
  }
}

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

async function queryAll(
  input: Record<string, any>,
): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const r: any = await ddb.send(
      new QueryCommand({ ...input, ExclusiveStartKey } as any),
    );
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function scanAll(table: string): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const r: any = await ddb.send(
      new ScanCommand({ TableName: table, ExclusiveStartKey }),
    );
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const batchPut = (table: string, items: Record<string, any>[]) =>
  batchWrite(
    table,
    items.map((Item) => ({ PutRequest: { Item } })),
  );

/** BatchWrite in chunks of 25 (DynamoDB's limit), retrying unprocessed items. */
async function batchWrite(
  table: string,
  requests: Record<string, any>[],
): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let pending: Record<string, any>[] = requests.slice(i, i + 25);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > 0)
        await new Promise((r) =>
          setTimeout(r, Math.min(1000, 50 * 2 ** attempt)),
        );
      if (attempt > 8)
        throw new Error(
          `batchWrite: ${pending.length} items still unprocessed`,
        );
      const r = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [table]: pending } }),
      );
      pending =
        (r.UnprocessedItems?.[table] as Record<string, any>[] | undefined) ??
        [];
    }
  }
}
