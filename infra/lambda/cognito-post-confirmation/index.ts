/**
 * Dewy Bank — Cognito Post-Confirmation trigger (Phase 1).
 *
 * On signup confirmation, idempotently provision a Customer record and seed a
 * SET of starter accounts (Checking, Savings, Credit Card) plus a handful of
 * realistic transactions (../shared/seed, shared with the reset — P10), so a
 * brand-new user lands in a rich, populated dashboard with multiple accounts
 * to transfer between.
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
import { SEED_ACCOUNTS, SEED_TXNS, accountIdFor, isoDaysAgo, seedTxnId } from '../shared/seed';

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
        // No email means no attribute: a null can't be written to the email-index key (C-P1).
        Item: { customerId: sub, email: email || undefined, createdAt: now },
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
    const accountId = accountIdFor(sub, def.suffix);
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
    const accountId = accountIdFor(sub, t.acct);
    const createdAt = isoDaysAgo(t.daysAgo);
    // Deterministic SK: timestamp#seedIndex so ordering + idempotency both hold.
    const txnId = seedTxnId(createdAt, i);
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
            channel: t.channel ?? 'seed',
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
