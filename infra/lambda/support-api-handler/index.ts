/**
 * Dewy Bank — Support API handler (C-P3; replaces the full-access Admin API, P7).
 *
 * A SEPARATE API Gateway HTTP API with no Cognito, authenticated by a STATIC
 * support-agent key in the `x-api-key` header. The key is read at cold start
 * from the SSM SecureString `/dewybank/<workshopId>/support-api-key`, minted at
 * deploy by support-api-key-gen. Participants see it as a "support code".
 *
 * Scope is the one thing this API enforces: it reaches only the support routes
 * and only the fictional customers (C-P4), whose customer and account rows carry
 * `fictional: true`. Anyone else answers 404. It makes no business decisions
 * (Factor II): any finite adjustment, any reason. The recipe's rules decide.
 *
 * Routes:
 *   GET  /support/whoami                          {role: "support-agent"} (connection test)
 *   GET  /support/customers/accounts?email=<e>    a fictional customer's accounts
 *   POST /support/adjustments {email, account_id, amount, reason}
 *                                                 adjust one account's balance
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomUUID, timingSafeEqual } from 'crypto';
import { parseMemo } from '../shared/memo';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({});

const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE!;
const API_KEY_PARAM = process.env.API_KEY_PARAM ?? '';
const OWNER_INDEX = 'owner-index';
const EMAIL_INDEX = 'email-index';

/** Cold-start-cached support key, fetched once from the SSM SecureString. */
let cachedApiKey: string | undefined;
async function getApiKey(): Promise<string> {
  if (cachedApiKey !== undefined) return cachedApiKey;
  if (!API_KEY_PARAM) {
    cachedApiKey = '';
    return cachedApiKey;
  }
  const r = await ssm.send(
    new GetParameterCommand({ Name: API_KEY_PARAM, WithDecryption: true }),
  );
  cachedApiKey = r.Parameter?.Value ?? '';
  return cachedApiKey;
}

type ApiEvent = {
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string | null;
  isBase64Encoded?: boolean;
};

type Resp = { statusCode: number; headers: Record<string, string>; body: string };

const json = (statusCode: number, obj: unknown): Resp => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

const toDollars = (cents: number): number => Math.round(cents) / 100;
const toCents = (dollars: number): number => Math.round(dollars * 100);

function viewAccount(a: Record<string, any>) {
  return {
    accountId: a.accountId,
    name: a.name ?? 'Checking',
    type: a.type ?? 'checking',
    currency: a.currency ?? 'USD',
    balance: toDollars(a.balanceCents ?? 0),
  };
}

export const handler = async (event: ApiEvent): Promise<Resp> => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.requestContext?.http?.path ?? event.rawPath ?? '/';
  const path = rawPath.replace(/\/+$/, '') || '/';
  const headers = lowerHeaders(event.headers);

  // ---- Support-agent key in `x-api-key`. Gates every route. ----------------
  const apiKey = await getApiKey();
  if (!apiKey || !sameKey(headers['x-api-key'], apiKey)) {
    return json(401, { message: 'Unauthorized: valid support code required' });
  }

  try {
    // GET /support/whoami — lets the connector check a code without reading or writing.
    if (method === 'GET' && path === '/support/whoami') {
      return json(200, { role: 'support-agent' });
    }

    // GET /support/customers/accounts?email=<email>
    if (method === 'GET' && path === '/support/customers/accounts') {
      const email = String(event.queryStringParameters?.email ?? '').trim();
      if (!email) return json(400, { message: 'email is required' });
      const customer = await findFictionalCustomer(email);
      if (!customer) return json(404, { message: 'Customer not found' });
      const accounts = await listFictionalAccounts(customer.customerId);
      return json(200, {
        customer: { email: customer.email },
        accounts: accounts.map(viewAccount),
      });
    }

    // POST /support/adjustments {email, account_id, amount, reason}
    if (method === 'POST' && path === '/support/adjustments') {
      const b = parseBody(event);
      const email = typeof b.email === 'string' ? b.email.trim() : '';
      const accountId = typeof b.account_id === 'string' ? b.account_id : '';
      const amount = Number(b.amount);
      if (!email || !accountId || b.amount === undefined || !Number.isFinite(amount) || typeof b.reason !== 'string') {
        return json(400, { message: 'email, account_id, a numeric amount and a reason are required' });
      }
      // The reason is stored as the row's memo, under the same rule as any memo (P2).
      const reason = parseMemo(b.reason, 'reason');
      if (!reason.ok) return json(400, { message: reason.message });

      const customer = await findFictionalCustomer(email);
      const account = customer ? await getAccount(accountId) : null;
      if (!customer || !account || account.fictional !== true || account.customerId !== customer.customerId) {
        return json(404, { message: 'Account not found' });
      }

      const cents = toCents(amount);
      const now = new Date().toISOString();
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: ACCOUNTS_TABLE,
                Key: { accountId },
                UpdateExpression: 'SET balanceCents = balanceCents + :amt',
                ExpressionAttributeValues: { ':amt': cents },
              },
            },
            {
              Put: {
                TableName: TRANSACTIONS_TABLE,
                Item: {
                  accountId,
                  txnId: `${now}#${randomUUID()}`,
                  type: 'credit',
                  amountCents: cents,
                  counterparty: 'Dewy Bank Support',
                  memo: reason.memo,
                  channel: 'support-adjustment',
                  category: 'Adjustment',
                  createdAt: now,
                },
              },
            },
          ],
        }),
      );
      const updated = await getAccount(accountId);
      return json(200, {
        message: 'Balance adjusted',
        account_id: accountId,
        amount: toDollars(cents),
        balance: toDollars(updated?.balanceCents ?? 0),
      });
    }

    return json(404, { message: `No route for ${method} ${path}` });
  } catch (err: any) {
    console.error('support-api-handler error', err);
    return json(500, { message: 'Internal error' });
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lowerHeaders(h?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/** Constant-time key comparison. */
function sameKey(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

/** A customer by email (C-P1), only if their row is marked fictional (C-P4). */
async function findFictionalCustomer(email: string): Promise<Record<string, any> | null> {
  for (const candidate of new Set([email, email.toLowerCase()])) {
    const r = await ddb.send(
      new QueryCommand({
        TableName: CUSTOMERS_TABLE,
        IndexName: EMAIL_INDEX,
        KeyConditionExpression: 'email = :e',
        ExpressionAttributeValues: { ':e': candidate },
        Limit: 1,
      }),
    );
    const c = r.Items?.[0];
    if (c) return c.fictional === true ? c : null;
  }
  return null;
}

async function listFictionalAccounts(customerId: string): Promise<Record<string, any>[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      IndexName: OWNER_INDEX,
      KeyConditionExpression: 'customerId = :c',
      ExpressionAttributeValues: { ':c': customerId },
    }),
  );
  return (r.Items ?? []).filter((a) => a.fictional === true);
}

async function getAccount(accountId: string): Promise<Record<string, any> | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { accountId }, ConsistentRead: true }),
  );
  return r.Item ?? null;
}
