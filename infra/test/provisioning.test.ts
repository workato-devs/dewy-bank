import { bankTables, TABLE_ENV, FakeDdb } from './fake-ddb';
import { FICTIONAL_CUSTOMERS, SEED_ACCOUNTS, SEED_TXNS, accountIdFor } from '../lambda/shared/seed';

let db: FakeDdb;

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: (cmd: any) => db.send(cmd) }) },
  };
});

Object.assign(process.env, TABLE_ENV);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../lambda/provisioning');

const ALICE = 'sub-alice';
const BOB = 'sub-bob';

beforeEach(() => {
  db = bankTables();
  for (const [sub, email] of [[ALICE, 'alice@example.org'], [BOB, 'bob@example.org']]) {
    db.put('Customers', { customerId: sub, email });
    for (const def of SEED_ACCOUNTS) {
      db.put('Accounts', { accountId: accountIdFor(sub, def.suffix), customerId: sub, name: def.name, type: def.type, currency: 'USD', balanceCents: 7_00 });
    }
    db.put('Transactions', { accountId: accountIdFor(sub, 'checking'), txnId: '2026-10-20T00:00:00.000Z#extra', type: 'debit', amountCents: 5_00, memo: 'Lunch' });
  }
});

const balances = (sub: string) =>
  SEED_ACCOUNTS.map((d) => db.get('Accounts', { accountId: accountIdFor(sub, d.suffix) })!.balanceCents);
const historyOf = (sub: string) =>
  db.all('Transactions').filter((t) => String(t.accountId).startsWith(`acct-${sub}-`));

test('setup creates the fictional customers with their seeded balances', async () => {
  const r = await handler({ action: 'setup' });
  expect(r).toMatchObject({ status: 'ok', fictional: 3 });
  for (const c of FICTIONAL_CUSTOMERS) {
    expect(db.get('Customers', { customerId: c.customerId })).toMatchObject({ email: c.email, fictional: true });
    for (const a of c.accounts) {
      expect(db.get('Accounts', { accountId: accountIdFor(c.customerId, a.suffix) })).toMatchObject({ balanceCents: a.balanceCents, fictional: true });
    }
  }
});

test('reseed with an email resets that participant to the shared seed', async () => {
  const r = await handler({ action: 'reseed', email: 'alice@example.org' });
  expect(r).toMatchObject({ status: 'ok', participants: 1 });
  expect(balances(ALICE)).toEqual(SEED_ACCOUNTS.map((d) => d.balanceCents));
  const memos = historyOf(ALICE).map((t) => t.memo).sort();
  expect(memos).toEqual(SEED_TXNS.map((t) => t.memo).sort());
  // Bob is untouched.
  expect(balances(BOB)).toEqual([7_00, 7_00, 7_00]);
  expect(historyOf(BOB).map((t) => t.memo)).toEqual(['Lunch']);
});

test('reseed without an email resets every participant and the fictional customers', async () => {
  const r = await handler({ action: 'reseed' });
  expect(r).toMatchObject({ status: 'ok', participants: 2, fictional: 3 });
  for (const sub of [ALICE, BOB]) {
    expect(balances(sub)).toEqual(SEED_ACCOUNTS.map((d) => d.balanceCents));
    expect(historyOf(sub)).toHaveLength(SEED_TXNS.length);
  }
  expect(db.get('Customers', { customerId: 'fictional-jane' })).toMatchObject({ fictional: true });
});

test('reseed is idempotent', async () => {
  await handler({ action: 'reseed' });
  await handler({ action: 'reseed' });
  expect(historyOf(ALICE)).toHaveLength(SEED_TXNS.length);
});
