import { bankTables, TABLE_ENV, FakeDdb } from './fake-ddb';
import { FICTIONAL_CUSTOMERS, accountIdFor } from '../lambda/shared/seed';

let db: FakeDdb;
const KEY = 'dwk_test_support_code';

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: (cmd: any) => db.send(cmd) }) },
  };
});
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: async () => ({ Parameter: { Value: KEY } }) })) };
});

Object.assign(process.env, TABLE_ENV, { API_KEY_PARAM: '/dewybank/test/support-api-key' });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../lambda/support-api-handler');

beforeEach(() => {
  db = bankTables();
  for (const c of FICTIONAL_CUSTOMERS) {
    db.put('Customers', { customerId: c.customerId, email: c.email, name: c.name, fictional: true });
    for (const a of c.accounts) {
      db.put('Accounts', {
        accountId: accountIdFor(c.customerId, a.suffix),
        customerId: c.customerId,
        name: a.name,
        type: a.type,
        currency: 'USD',
        balanceCents: a.balanceCents,
        fictional: true,
      });
    }
  }
});

function call(method: string, path: string, opts: { body?: unknown; query?: Record<string, string>; key?: string } = {}) {
  return handler({
    requestContext: { http: { method, path } },
    headers: { 'X-Api-Key': opts.key ?? KEY },
    queryStringParameters: opts.query,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }).then((r: any) => ({ status: r.statusCode, body: JSON.parse(r.body) }));
}

const janeChecking = accountIdFor('fictional-jane', 'checking');

test('GET /support/whoami answers with the support role', async () => {
  expect(await call('GET', '/support/whoami')).toEqual({ status: 200, body: { role: 'support-agent' } });
});

test('a request without the support code gets 401', async () => {
  expect((await call('GET', '/support/whoami', { key: '' })).status).toBe(401);
});

test('GET /support/customers/accounts lists a fictional customer’s accounts', async () => {
  const r = await call('GET', '/support/customers/accounts', { query: { email: 'jane@example.com' } });
  expect(r.status).toBe(200);
  expect(r.body.customer).toEqual({ email: 'jane@example.com' });
  expect(r.body.accounts).toEqual(
    expect.arrayContaining([
      { accountId: janeChecking, name: 'Everyday Checking', type: 'checking', currency: 'USD', balance: 58.2 },
    ]),
  );
  expect(r.body.accounts).toHaveLength(3);
});

test('POST /support/adjustments credits the account and records the reason as the memo', async () => {
  const r = await call('POST', '/support/adjustments', {
    body: { email: 'jane@example.com', account_id: janeChecking, amount: 90, reason: 'Late fee refund' },
  });
  expect(r).toEqual({
    status: 200,
    body: { message: 'Balance adjusted', account_id: janeChecking, amount: 90, balance: 148.2 },
  });
  expect(db.all('Transactions')).toEqual([
    expect.objectContaining({ accountId: janeChecking, memo: 'Late fee refund', channel: 'support-adjustment', amountCents: 90_00 }),
  ]);
});

test('an adjustment with a missing field gets 400', async () => {
  const r = await call('POST', '/support/adjustments', { body: { email: 'jane@example.com', account_id: janeChecking, reason: 'x' } });
  expect(r.status).toBe(400);
});
