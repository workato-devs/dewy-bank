/**
 * Dewy Bank — Chat proxy (P8).
 *
 * Lets the bank app's chat panel talk to the participant's own Genies through
 * Workato's Genie Headless API, without the browser ever holding a Workato
 * credential. Sits behind the customer API's Cognito JWT authorizer; every row
 * is keyed by the caller's validated `sub`.
 *
 * Routes:
 *   PUT  /me/genie-clients     store the blob printed by scripts/setup_chat_clients.py.
 *                              WRITE-ONLY: keys are never returned or logged.
 *   GET  /me/genie-clients     which stations are configured (true/false each)
 *   POST /chat {station, message?, conversation?, approval?: {call_id, resolution}}
 *                              sends a message (creating a conversation if none is
 *                              given), or answers a skill confirmation
 *   GET  /chat/events?station=&conversation=&since=
 *                              relays the conversation's events for the panel to poll
 *
 * Sending is asynchronous on Workato's side (202 + genie_run_id), so nothing here
 * waits on a Genie turn: the panel polls /chat/events until the run's agent.message
 * (the events feed has no end-of-turn event; observed 2026-10-22).
 * Events are relayed as Workato returns them.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const GENIE_CLIENTS_TABLE = process.env.GENIE_CLIENTS_TABLE!;

/** The customer-facing Genies. The panel never connects to C2's support Genie. */
export const STATIONS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
type Station = (typeof STATIONS)[number];

/** Workato's Headless API hosts, per data center (e.g. genie-api.trial.workato.com). */
const GENIE_HOST = /^genie-api(\.[a-z0-9-]+)*\.workato\.com$/;
/** The Headless API's limit on one message. */
const MAX_MESSAGE_BYTES = 12 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

type ApiEvent = {
  requestContext?: {
    http?: { method?: string; path?: string };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
  rawPath?: string;
  queryStringParameters?: Record<string, string>;
  body?: string | null;
  isBase64Encoded?: boolean;
};

type Resp = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

type StationClient = { genie_id: string; api_key: string };
type ClientsRow = {
  customerId: string;
  genieApiHost: string;
  idpUserId: string;
  stations: Partial<Record<Station, StationClient>>;
  updatedAt: string;
};

const json = (statusCode: number, obj: unknown): Resp => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});

export const handler = async (event: ApiEvent): Promise<Resp> => {
  const method = event.requestContext?.http?.method ?? "GET";
  const rawPath = event.requestContext?.http?.path ?? event.rawPath ?? "/";
  const path = rawPath.replace(/\/+$/, "") || "/";

  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub as
    | string
    | undefined;
  if (!sub)
    return json(401, { message: "Unauthorized: missing JWT sub claim" });

  try {
    // PUT /me/genie-clients — store the setup blob (write-only).
    if (method === "PUT" && path === "/me/genie-clients") {
      const parsed = parseClientsBlob(parseBody(event));
      if (!parsed.ok) return json(400, { message: parsed.message });
      const row: ClientsRow = {
        customerId: sub,
        ...parsed.value,
        updatedAt: new Date().toISOString(),
      };
      await ddb.send(
        new PutCommand({ TableName: GENIE_CLIENTS_TABLE, Item: row }),
      );
      return json(200, {
        message: "Chat clients saved",
        stations: configured(row),
      });
    }

    // GET /me/genie-clients — which stations are configured. Never returns a key.
    if (method === "GET" && path === "/me/genie-clients") {
      const row = await getRow(sub);
      return json(200, { stations: configured(row) });
    }

    // POST /chat
    if (method === "POST" && path === "/chat") {
      const b = parseBody(event);
      const target = await resolveStation(sub, b.station);
      if (!target.ok) return target.resp;
      const { base, headers } = target;

      let conversation =
        typeof b.conversation === "string" && b.conversation
          ? b.conversation
          : undefined;

      if (b.approval !== undefined) {
        const a = b.approval as Record<string, unknown> | null;
        const callId = typeof a?.call_id === "string" ? a.call_id : "";
        const resolution = a?.resolution;
        if (
          !conversation ||
          !callId ||
          (resolution !== "approved" && resolution !== "rejected")
        ) {
          return json(400, {
            message:
              "approval needs a conversation, a call_id and a resolution of approved or rejected",
          });
        }
        const r = await upstream(
          "POST",
          `${base}/conversations/${enc(conversation)}/skill_approval/${enc(callId)}`,
          headers,
          { resolution },
        );
        if (!r.ok) return r.resp;
        return json(200, { conversation });
      }

      const message = typeof b.message === "string" ? b.message : "";
      if (!message) return json(400, { message: "message is required" });
      if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
        return json(400, {
          message: `message must be at most ${MAX_MESSAGE_BYTES} bytes`,
        });
      }

      if (!conversation) {
        const r = await upstream("POST", `${base}/conversations`, headers, {});
        if (!r.ok) return r.resp;
        conversation =
          r.body?.result?.conversation_id ?? r.body?.conversation_id;
        if (!conversation)
          return json(502, {
            message: "The Genie API did not return a conversation",
          });
      }
      const r = await upstream(
        "POST",
        `${base}/conversations/${enc(conversation)}/messages`,
        headers,
        { message, stream: false },
      );
      if (!r.ok) return r.resp;
      return json(200, {
        conversation,
        run: r.body?.result?.genie_run_id ?? r.body?.genie_run_id ?? null,
      });
    }

    // GET /chat/events?station=&conversation=&since=
    if (method === "GET" && path === "/chat/events") {
      const q = event.queryStringParameters ?? {};
      const target = await resolveStation(sub, q.station);
      if (!target.ok) return target.resp;
      if (!q.conversation)
        return json(400, { message: "conversation is required" });
      const params = new URLSearchParams({ conversation_id: q.conversation });
      if (q.since) params.set("since_created_at", q.since);
      const r = await upstream(
        "GET",
        `${target.base}/conversations/events?${params}`,
        target.headers,
      );
      if (!r.ok) return r.resp;
      const raw = (r.body as any)?.result ?? r.body;
      const status: string | null =
        (typeof raw?.status === "string" ? raw.status : null) ??
        (typeof (r.body as any)?.status === "string"
          ? (r.body as any).status
          : null);
      return json(200, { conversation: q.conversation, events: raw, status });
    }

    return json(404, { message: `No route for ${method} ${path}` });
  } catch (err: any) {
    // Never log request headers or the row: they hold Genie keys.
    console.error("chat-handler error", err?.name, err?.message);
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

const enc = encodeURIComponent;

type Parsed =
  | { ok: true; value: Omit<ClientsRow, "customerId" | "updatedAt"> }
  | { ok: false; message: string };

/** Validate the blob from scripts/setup_chat_clients.py. */
export function parseClientsBlob(b: Record<string, unknown>): Parsed {
  if (b.version !== 1)
    return { ok: false, message: "Unsupported blob version (expected 1)" };
  const host =
    typeof b.genie_api_host === "string" ? b.genie_api_host.toLowerCase() : "";
  if (!GENIE_HOST.test(host))
    return {
      ok: false,
      message: "genie_api_host must be a Workato Genie API host",
    };
  const idp = b.idp_user_id;
  if (
    (typeof idp !== "string" && typeof idp !== "number") ||
    String(idp) === ""
  ) {
    return { ok: false, message: "idp_user_id is required" };
  }
  const raw = b.stations;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, message: "stations is required" };
  const stations: Partial<Record<Station, StationClient>> = {};
  for (const [name, v] of Object.entries(raw as Record<string, any>)) {
    if (!(STATIONS as readonly string[]).includes(name)) {
      return {
        ok: false,
        message: `Unknown station ${name} (expected ${STATIONS.join(", ")})`,
      };
    }
    if (
      typeof v?.genie_id !== "string" ||
      !v.genie_id ||
      typeof v?.api_key !== "string" ||
      !v.api_key
    ) {
      return {
        ok: false,
        message: `Station ${name} needs a genie_id and an api_key`,
      };
    }
    stations[name as Station] = { genie_id: v.genie_id, api_key: v.api_key };
  }
  if (Object.keys(stations).length === 0)
    return { ok: false, message: "stations is empty" };
  return {
    ok: true,
    value: { genieApiHost: host, idpUserId: String(idp), stations },
  };
}

function configured(row: ClientsRow | null): Record<Station, boolean> {
  return Object.fromEntries(
    STATIONS.map((s) => [s, Boolean(row?.stations?.[s])]),
  ) as Record<Station, boolean>;
}

async function getRow(sub: string): Promise<ClientsRow | null> {
  const r = await ddb.send(
    new GetCommand({
      TableName: GENIE_CLIENTS_TABLE,
      Key: { customerId: sub },
    }),
  );
  return (r.Item as ClientsRow | undefined) ?? null;
}

type Target =
  | { ok: true; base: string; headers: Record<string, string> }
  | { ok: false; resp: Resp };

async function resolveStation(sub: string, station: unknown): Promise<Target> {
  if (
    typeof station !== "string" ||
    !(STATIONS as readonly string[]).includes(station)
  ) {
    return {
      ok: false,
      resp: json(400, {
        message: `station must be one of ${STATIONS.join(", ")}`,
      }),
    };
  }
  const row = await getRow(sub);
  const client = row?.stations?.[station as Station];
  if (!row || !client)
    return {
      ok: false,
      resp: json(404, { message: `Station ${station} isn't set up yet` }),
    };
  return {
    ok: true,
    base: `https://${row.genieApiHost}/api/v1/genies/${enc(client.genie_id)}/chat`,
    headers: {
      authorization: `Bearer ${client.api_key}`,
      "x-idp-user-id": row.idpUserId,
    },
  };
}

type Upstream = { ok: true; body: any } | { ok: false; resp: Resp };

/** Call the Headless API. A non-2xx answer becomes a 502 carrying Workato's status and error code. */
async function upstream(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Upstream> {
  const r = await fetch(url, {
    method,
    headers: {
      ...headers,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (r.ok) return { ok: true, body: parsed };
  const code = parsed?.error?.code ?? parsed?.code ?? parsed?.error ?? null;
  return {
    ok: false,
    resp: json(502, {
      message: "The Genie API returned an error",
      upstream_status: r.status,
      upstream_error: typeof code === "string" ? code : null,
    }),
  };
}
