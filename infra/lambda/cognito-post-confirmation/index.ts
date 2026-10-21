/**
 * Dewy Bank — Cognito Post-Confirmation trigger (Phase 1).
 *
 * On signup confirmation, idempotently provision a Customer record and seed a
 * SET of starter accounts (Checking, Savings, Credit Card) plus a handful of
 * realistic transactions, so a brand-new user lands in a rich, populated
 * dashboard with multiple accounts to transfer between.
 *
 * Cognito can retry the trigger, so every write is conditional
 * (attribute_not_exists) and all ids are DERIVED from the sub so a retry
 * targets the same rows (idempotent). We swallow ConditionalCheckFailed
 * (already seeded) and never throw for a benign duplicate — a thrown trigger
 * fails the user's confirmation.
 *
 * Money is stored in integer CENTS. Credit balances are represented as negative
 * cents (money owed).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE!;

type PostConfirmationEvent = {
  triggerSource?: string;
  userName?: string;
  request?: { userAttributes?: Record<string, string> };
  [k: string]: unknown;
};

/** Starter account definitions, seeded once per new customer. */
type SeedAccount = {
  suffix: string;
  name: string;
  type: 'checking' | 'savings' | 'credit';
  currency: string;
  balanceCents: number;
};

const SEED_ACCOUNTS: SeedAccount[] = [
  { suffix: 'checking', name: 'Everyday Checking', type: 'checking', currency: 'USD', balanceCents: 342_15 },
  { suffix: 'savings', name: 'High-Yield Savings', type: 'savings', currency: 'USD', balanceCents: 12_480_00 },
  { suffix: 'credit', name: 'Dewy Platinum Card', type: 'credit', currency: 'USD', balanceCents: -1_284_57 },
];

/**
 * Seed transactions, keyed by account suffix. `daysAgo` + `type` + `amountCents`
 * (positive = credit/inflow, negative = debit/outflow). createdAt is derived so
 * the history reads naturally newest-first.
 */
type SeedTxn = {
  acct: string;
  daysAgo: number;
  type: 'debit' | 'credit';
  amountCents: number;
  memo: string;
  counterparty: string;
  category: string;
};

const SEED_TXNS: SeedTxn[] = [
  { acct: 'checking', daysAgo: 1, type: 'debit', amountCents: 64_20, memo: 'Blue Bottle Coffee', counterparty: 'Blue Bottle', category: 'Dining' },
  { acct: 'checking', daysAgo: 2, type: 'debit', amountCents: 128_99, memo: 'Whole Foods Market', counterparty: 'Whole Foods', category: 'Groceries' },
  { acct: 'checking', daysAgo: 3, type: 'credit', amountCents: 2_450_00, memo: 'Payroll — Acme Corp', counterparty: 'Acme Corp', category: 'Income' },
  { acct: 'checking', daysAgo: 5, type: 'debit', amountCents: 54_30, memo: 'Shell Gas Station', counterparty: 'Shell', category: 'Transport' },
  { acct: 'checking', daysAgo: 8, type: 'debit', amountCents: 1_650_00, memo: 'Rent — October', counterparty: 'Parkview Apartments', category: 'Housing' },
  { acct: 'savings', daysAgo: 3, type: 'credit', amountCents: 500_00, memo: 'Monthly auto-save', counterparty: 'Everyday Checking', category: 'Transfer' },
  { acct: 'savings', daysAgo: 30, type: 'credit', amountCents: 41_73, memo: 'Interest earned', counterparty: 'Dewy Bank', category: 'Interest' },
  { acct: 'credit', daysAgo: 2, type: 'debit', amountCents: 89_99, memo: 'Amazon.com', counterparty: 'Amazon', category: 'Shopping' },
  { acct: 'credit', daysAgo: 4, type: 'debit', amountCents: 42_18, memo: 'Uber ride', counterparty: 'Uber', category: 'Transport' },
  { acct: 'credit', daysAgo: 6, type: 'debit', amountCents: 215_40, memo: 'Delta Air Lines', counterparty: 'Delta', category: 'Travel' },
];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export const handler = async (
  event: PostConfirmationEvent,
): Promise<PostConfirmationEvent> => {
  if (event.triggerSource && event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  const attrs = event.request?.userAttributes ?? {};
  const sub = attrs.sub;
  const email = attrs.email;
  if (!sub) {
    console.warn('post-confirmation: no sub in userAttributes; skipping seed');
    return event;
  }

  const now = new Date().toISOString();

  // 1) Customer record — created once.
  try {
    await ddb.send(
      new PutCommand({
        TableName: CUSTOMERS_TABLE,
        Item: { customerId: sub, email: email ?? null, createdAt: now },
        ConditionExpression: 'attribute_not_exists(customerId)',
      }),
    );
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.error('post-confirmation: customer put failed', err);
    }
  }

  // 2) Starter accounts — created once each (deterministic ids for idempotency).
  for (const def of SEED_ACCOUNTS) {
    const accountId = `acct-${sub}-${def.suffix}`;
    try {
      await ddb.send(
        new PutCommand({
          TableName: ACCOUNTS_TABLE,
          Item: {
            accountId,
            customerId: sub, // owner-index GSI partition key
            name: def.name,
            type: def.type,
            currency: def.currency,
            balanceCents: def.balanceCents,
            createdAt: now,
          },
          ConditionExpression: 'attribute_not_exists(accountId)',
        }),
      );
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') {
        console.error(`post-confirmation: account ${def.suffix} put failed`, err);
      }
    }
  }

  // 3) Seed transactions — deterministic txnId so retries are idempotent.
  for (let i = 0; i < SEED_TXNS.length; i++) {
    const t = SEED_TXNS[i];
    const accountId = `acct-${sub}-${t.acct}`;
    const createdAt = isoDaysAgo(t.daysAgo);
    // Deterministic SK: timestamp#seedIndex so ordering + idempotency both hold.
    const txnId = `${createdAt}#seed-${i}`;
    try {
      await ddb.send(
        new PutCommand({
          TableName: TRANSACTIONS_TABLE,
          Item: {
            accountId,
            txnId,
            type: t.type,
            amountCents: t.amountCents,
            counterparty: t.counterparty,
            memo: t.memo,
            category: t.category,
            createdAt,
          },
          ConditionExpression: 'attribute_not_exists(txnId)',
        }),
      );
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') {
        console.error(`post-confirmation: seed txn ${i} put failed`, err);
      }
    }
  }

  console.log(`post-confirmation: seeded ${SEED_ACCOUNTS.length} accounts + ${SEED_TXNS.length} txns for sub ${sub}`);
  return event;
};
