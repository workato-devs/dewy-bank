/**
 * Dewy Bank — Bedrock + MCP chat handler.
 *
 * Streams an SSE response via Lambda Function URL (RESPONSE_STREAM).
 * Validates the Cognito JWT before opening the stream (auth failures → HTTP 401).
 * Connects to a Workato MCP server (per station) and drives a Bedrock Converse
 * loop, streaming tool_start / tool_result / text events to the browser.
 *
 * MCP URLs are resolved exclusively from Lambda env vars (SSRF prevention).
 * No DynamoDB access — fully stateless; the SPA maintains conversation history.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import {
  Client,
  StreamableHTTPClientTransport,
  SSEClientTransport,
} from "@modelcontextprotocol/client";
import { CognitoJwtVerifier } from "aws-jwt-verify";

// ── Streaming handler types (not yet in @types/aws-lambda) ───────────────────
declare global {
  namespace awslambda {
    function streamifyResponse(
      handler: (event: any, responseStream: any, context: any) => Promise<void>,
    ): any;
    namespace HttpResponseStream {
      function from(
        stream: any,
        metadata: { statusCode: number; headers: Record<string, string> },
      ): any;
    }
  }
}

export const STATIONS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
type Station = (typeof STATIONS)[number];

// ── Cold-start singletons ────────────────────────────────────────────────────
const bedrock = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION ?? "us-west-2",
});

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  tokenUse: "id",
  clientId: process.env.COGNITO_CLIENT_ID!,
});

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.moonshotai.kimi-k3";
const MAX_TOKENS = 4096;
const MAX_HISTORY = 80;

// ── Handler ──────────────────────────────────────────────────────────────────
export const handler = awslambda.streamifyResponse(
  async (event: any, responseStream: any): Promise<void> => {
    // ── 1. Validate JWT BEFORE opening the SSE stream ───────────────────────
    // Auth failures return HTTP 401 with a JSON body, not a 200 SSE error.
    const authHeader: string | undefined =
      event.headers?.authorization ?? event.headers?.Authorization;
    const token = authHeader?.replace(/^Bearer\s+/i, "");

    if (!token) {
      const s = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 401,
        headers: { "content-type": "application/json" },
      });
      s.end(JSON.stringify({ message: "Unauthorized: missing token" }));
      return;
    }
    try {
      await verifier.verify(token);
    } catch {
      const s = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 401,
        headers: { "content-type": "application/json" },
      });
      s.end(JSON.stringify({ message: "Unauthorized: invalid token" }));
      return;
    }

    // ── 2. Open the SSE stream — only reached on valid JWT ───────────────────
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });

    const send = (payload: object) =>
      httpStream.write(`data: ${JSON.stringify(payload)}\n\n`);

    let mcpClient: Client | null = null;
    let mcpTransport: any | null = null;

    try {
      // ── 3. Parse body ──────────────────────────────────────────────────────
      const body = parseBody(event);
      const station = body.station as string;
      if (!station || !(STATIONS as readonly string[]).includes(station)) {
        send({
          type: "error",
          message: `Invalid station. Expected one of ${STATIONS.join(", ")}`,
        });
        return;
      }
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];

      // ── 4. Resolve MCP URL ─────────────────────────────────────────────────
      // SSRF prevention: MCP URLs come exclusively from env vars.
      // The request body cannot influence which URL is called.
      const mcpUrl = process.env[`MCP_URL_${station}`];
      if (!mcpUrl) {
        send({
          type: "error",
          message: `Station ${station} is not configured`,
        });
        return;
      }

      // ── 5. Convert messages to Bedrock format ──────────────────────────────
      const bedrockMessages: Message[] = rawMessages
        .slice(-MAX_HISTORY)
        .map((m: any) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: [{ text: typeof m.content === "string" ? m.content : "" }],
        }));
      if (
        !bedrockMessages.length ||
        bedrockMessages[bedrockMessages.length - 1].role !== "user"
      ) {
        send({ type: "error", message: "messages must end with a user turn" });
        return;
      }

      // ── 6. Connect MCP with 10-second timeout ─────────────────────────────
      send({ type: "status", message: "Connecting to tools\u2026" });
      const mcpToken = getMcpToken(station as Station);
      const requestInit = mcpToken
        ? { headers: { Authorization: `Bearer ${mcpToken}` } }
        : undefined;

      const url = new URL(mcpUrl);
      try {
        mcpClient = new Client({ name: "dewy-bank-chat", version: "1.0.0" });
        mcpTransport = new StreamableHTTPClientTransport(url, { requestInit });
        await connectWithTimeout(() => mcpClient!.connect(mcpTransport!));
      } catch {
        // Fall back to SSE transport — pass the same requestInit so bearer
        // auth works regardless of which transport the MCP server accepts.
        mcpClient = new Client({ name: "dewy-bank-chat", version: "1.0.0" });
        mcpTransport = new SSEClientTransport(url, { requestInit });
        await connectWithTimeout(() => mcpClient!.connect(mcpTransport!));
      }

      const { tools: mcpTools } = await mcpClient.listTools();
      const bedrockTools = mcpTools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description ?? `Tool: ${t.name}`,
          inputSchema: {
            json: t.inputSchema ?? { type: "object", properties: {} },
          },
        },
      }));

      send({
        type: "tools",
        tools: mcpTools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      });

      const instructions = (mcpClient as any).getInstructions?.();
      const systemPrompt: Array<{ text: string }> | undefined = instructions
        ? [{ text: instructions }]
        : undefined;

      // ── 7. Bedrock conversation loop ───────────────────────────────────────
      let continueLoop = true;
      while (continueLoop) {
        const input: any = {
          modelId: MODEL_ID,
          messages: bedrockMessages,
          inferenceConfig: { maxTokens: MAX_TOKENS },
          ...(bedrockTools.length && { toolConfig: { tools: bedrockTools } }),
          ...(systemPrompt && { system: systemPrompt }),
        };

        const response = await bedrock.send(new ConverseCommand(input));
        const outMsg = response.output?.message;
        if (!outMsg) break;
        bedrockMessages.push(outMsg);

        const stopReason = response.stopReason;

        if (stopReason === "end_turn" || stopReason === "max_tokens") {
          const text = (outMsg.content ?? [])
            .filter((c: any) => c.text)
            .map((c: any) => c.text)
            .join("");
          send({ type: "text", content: text, modelId: MODEL_ID, stopReason });
          continueLoop = false;
        } else if (stopReason === "tool_use") {
          const toolResults: any[] = [];

          for (const block of outMsg.content ?? []) {
            if (!block.toolUse) continue;
            const { toolUseId, name, input: toolInput } = block.toolUse;

            // Include toolUseId so the SPA can key pending cards uniquely —
            // handles the case where the same tool is called twice in one turn.
            send({ type: "tool_start", name, toolUseId, input: toolInput });

            let resultText: string;
            let isError = false;
            try {
              const result = await mcpClient!.callTool({
                name: name!,
                arguments: (toolInput ?? {}) as Record<string, unknown>,
              });
              isError = !!result.isError;
              resultText = (result.content as any[])
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n");
            } catch (err: any) {
              resultText = `Error: ${err.message}`;
              isError = true;
            }

            // resultText may contain customer account data — never log it.
            send({
              type: "tool_result",
              name,
              toolUseId,
              result: resultText,
              isError,
            });
            toolResults.push({
              toolResult: {
                toolUseId,
                content: [{ text: resultText }],
                ...(isError && { status: "error" }),
              },
            });
          }
          bedrockMessages.push({ role: "user", content: toolResults });
        } else {
          continueLoop = false;
        }
      }

      send({ type: "done" });
    } catch (err: any) {
      // Log error type and message only — never headers, tokens, or tool output.
      console.error("chat-bedrock error", err?.name, err?.message);
      send({
        type: "error",
        message: err.message ?? String(err),
        errorType: err.name,
        httpStatus: err.$metadata?.httpStatusCode,
      });
    } finally {
      try {
        await (mcpTransport as any)?.terminateSession?.();
      } catch {}
      try {
        await mcpClient?.close();
      } catch {}
      try {
        httpStream.end();
      } catch {}
    }
  },
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseBody(event: any): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getMcpToken(station: Station): string | undefined {
  return (
    process.env[`MCP_BEARER_TOKEN_${station}`] ?? process.env.MCP_BEARER_TOKEN
  );
}

async function connectWithTimeout<T>(
  fn: () => Promise<T>,
  ms = 10_000,
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error(`MCP connect timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}
