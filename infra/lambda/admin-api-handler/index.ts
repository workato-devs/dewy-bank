/**
 * Dewy Bank — Admin API handler (Phase 1).
 *
 * A SEPARATE API Gateway HTTP API, authenticated by a STATIC API KEY in the
 * `x-api-key` header (decision 6.6), consumed by the Workato recipe layer. The
 * key value is injected as env API_KEY from the SSM SecureString
 * `/dewybank/<workshopId>/admin-api-key` at deploy time.
 *
 * This single Lambda hosts TWO contrasting route sets — the teaching core of
 * the workshop (plan §2):
 *
 * INSECURE (raw, NO per-account authz — intentional for the heist):
 *   GET  /admin/accounts            list ALL accounts (enumeration allowed — 6.7)
 *   GET  /admin/accounts/{id}       any account
 *   POST /admin/transfer            raw {from,to,amount} — forwards args VERBATIM
 *   POST /admin/adjust-balance      {id,amount} admin mint/seed/reset (6.3)
 *
 * SECURE (defense-in-depth — deterministic layer owns the authz decision):
 *   POST /admin/secure/transfer     {amount,to} — the SOURCE account is NOT a
 *                                   parameter; it is re-derived server-side from
 *                                   the PINNED-PRINCIPAL header `x-participant-sub`.
 *                                   `to` is validated against an allow-list
 *                                   (the principal's OWN other accounts); a
 *                                   per-transfer LIMIT is enforced.
 *   GET  /admin/secure/my-accounts  accounts for the pinned principal ONLY.
 *
 * Pinned-principal header name: `x-participant-sub` (documented contract for the
 * secure Workato connection; the LLM can never name a `from` account).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomUUID } from 'crypto';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({});

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const TRANSACTIONS_TABLE = process.env.TRANSACTIONS_TABLE!;
const API_KEY_PARAM = process.env.API_KEY_PARAM ?? '';
const OWNER_INDEX = 'owner-index';

/** Cold-start-cached API key, fetched once from the SSM SecureString. */
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

/** Pinned-principal header the secure routes re-derive the source account from. */
const PRINCIPAL_HEADER = 'x-participant-sub';
/** Per-transfer limit on the secure path (dollars). */
const SECURE_TRANSFER_LIMIT = 500.0;

type ApiEvent = {
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
  headers?: Record<string, string>;
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
    customerId: a.customerId,
    name: a.name ?? 'Checking',
    currency: a.currency ?? 'USD',
    balance: toDollars(a.balanceCents ?? 0),
  };
}

export const handler = async (event: ApiEvent): Promise<Resp> => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.requestContext?.http?.path ?? event.rawPath ?? '/';
  const path = rawPath.replace(/\/+$/, '') || '/';
  const headers = lowerHeaders(event.headers);

  // ---- API-KEY auth (decision 6.6). Static key in `x-api-key`. -------------
  // This gates the whole Admin API. The INSECURE routes over-trust the CALLER
  // (any valid-key holder can move anyone's money) — but the key itself is real
  // so the environment isn't exposed beyond the workshop.
  const apiKey = await getApiKey();
  if (!apiKey || headers['x-api-key'] !== apiKey) {
    return json(401, { message: 'Unauthorized: valid x-api-key required' });
  }

  try {
    // =====================================================================
    // INSECURE routes — raw primitives, NO per-account authorization.
    // =====================================================================

    // GET /admin/accounts — list ALL accounts (enumeration is the exploit).
    if (method === 'GET' && path === '/admin/accounts') {
      const items = await scanAllAccounts();
      return json(200, { accounts: items.map(viewAccount) });
    }

    // GET /admin/accounts/{id} — any account, no ownership check.
    let m = path.match(/^\/admin\/accounts\/([^/]+)$/);
    if (method === 'GET' && m) {
      const r = await ddb.send(
        new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { accountId: m[1] } }),
      );
      if (!r.Item) return json(404, { message: 'Account not found' });
      return json(200, viewAccount(r.Item));
    }

    // POST /admin/transfer — raw {from,to,amount}, forwarded VERBATIM.
    if (method === 'POST' && path === '/admin/transfer') {
      const b = parseBody(event);
      const from = String(b.from ?? '');
      const to = String(b.to ?? '');
      const amount = Number(b.amount);
      if (!from || !to || !Number.isFinite(amount) || amount <= 0) {
        return json(400, { message: 'from, to and a positive amount are required' });
      }
      // NO ownership check, NO allow-list, NO limit — by design (the heist).
      await moveFunds(from, to, toCents(amount), 'admin-raw-transfer');
      return json(200, {
        message: 'Transfer complete',
        from,
        to,
        amount: toDollars(toCents(amount)),
      });
    }

    // POST /admin/adjust-balance — {id,amount} admin mint/seed/reset.
    if (method === 'POST' && path === '/admin/adjust-balance') {
      const b = parseBody(event);
      const id = String(b.id ?? '');
      const amount = Number(b.amount); // may be negative
      if (!id || !Number.isFinite(amount)) {
        return json(400, { message: 'id and a numeric amount are required' });
      }
      const cents = toCents(amount);
      const r = await ddb.send(
        new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { accountId: id },
          UpdateExpression:
            'SET balanceCents = if_not_exists(balanceCents, :zero) + :amt',
          ExpressionAttributeValues: { ':amt': cents, ':zero': 0 },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return json(200, {
        message: 'Balance adjusted',
        accountId: id,
        balance: toDollars(r.Attributes?.balanceCents ?? 0),
      });
    }

    // =====================================================================
    // SECURE routes — deterministic authz owns the decision (defense in depth).
    // =====================================================================

    // GET /admin/secure/my-accounts — accounts for the pinned principal only.
    if (method === 'GET' && path === '/admin/secure/my-accounts') {
      const principal = headers[PRINCIPAL_HEADER];
      if (!principal) {
        return json(400, { message: `Missing pinned-principal header ${PRINCIPAL_HEADER}` });
      }
      const accounts = await listOwnedAccounts(principal);
      return json(200, { accounts: accounts.map(viewAccount) });
    }

    // POST /admin/secure/transfer — {amount,to}; source re-derived server-side.
    if (method === 'POST' && path === '/admin/secure/transfer') {
      const principal = headers[PRINCIPAL_HEADER];
      if (!principal) {
        return json(400, { message: `Missing pinned-principal header ${PRINCIPAL_HEADER}` });
      }
      const b = parseBody(event);
      const to = String(b.to ?? '');
      const amount = Number(b.amount);
      if (!to || !Number.isFinite(amount) || amount <= 0) {
        return json(400, { message: 'to and a positive amount are required' });
      }
      // 1) Enforce per-transfer limit deterministically.
      if (amount > SECURE_TRANSFER_LIMIT) {
        return json(422, {
          message: `Amount exceeds per-transfer limit of ${SECURE_TRANSFER_LIMIT}`,
        });
      }
      // 2) Re-derive the SOURCE from the pinned principal — the LLM can never
      //    name it. We use the principal's first (primary) account as source.
      const owned = await listOwnedAccounts(principal);
      if (owned.length === 0) {
        return json(403, { message: 'Pinned principal owns no accounts' });
      }
      const source = owned[0];
      // 3) Allow-list the destination: it MUST be another account owned by the
      //    SAME principal. Exfiltration to a foreign account is rejected here.
      const allowed = new Set(owned.map((a) => a.accountId));
      if (!allowed.has(to)) {
        return json(403, {
          message: 'Destination not permitted: must be one of the principal\'s own accounts',
        });
      }
      if (to === source.accountId) {
        return json(400, { message: 'Destination must differ from the derived source' });
      }
      const cents = toCents(amount);
      if ((source.balanceCents ?? 0) < cents) {
        return json(422, { message: 'Insufficient funds' });
      }
      await moveFunds(source.accountId, to, cents, 'admin-secure-transfer');
      return json(200, {
        message: 'Secure transfer complete',
        from: source.accountId, // reported for transparency; NOT caller-supplied
        to,
        amount: toDollars(cents),
      });
    }

    return json(404, { message: `No route for ${method} ${path}` });
  } catch (err: any) {
    console.error('admin-api-handler error', err);
    if (err?.name === 'TransactionCanceledException') {
      return json(409, { message: 'Transfer could not be completed (balance changed)' });
    }
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
            UpdateExpression:
              'SET balanceCents = if_not_exists(balanceCents, :zero) + :amt',
            ExpressionAttributeValues: { ':amt': cents, ':zero': 0 },
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
