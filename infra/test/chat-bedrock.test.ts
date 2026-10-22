/**
 * Unit tests for the Bedrock + MCP chat Lambda handler.
 *
 * The awslambda streaming globals must be set BEFORE the handler module is
 * required, because awslambda.streamifyResponse() is called at module
 * evaluation time (not inside the handler body).
 */

// ── awslambda runtime globals (Lambda-only; must be set before require) ────────
const mockStreamWrites: string[] = [];
const mockStream = {
  write: (chunk: string) => {
    mockStreamWrites.push(chunk);
  },
  end: jest.fn(),
};

(global as any).awslambda = {
  // Return the handler function as-is so tests can call it directly.
  streamifyResponse: (fn: any) => fn,
  HttpResponseStream: {
    from: (_stream: any, meta: { statusCode: number; headers: Record<string, string> }) => ({
      ...mockStream,
      __meta: meta,
    }),
  },
};

// ── Mock aws-jwt-verify ─────────────────────────────────────────────────────────
const mockVerify = jest.fn();
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: () => ({ verify: mockVerify }),
  },
}));

// ── Mock @aws-sdk/client-bedrock-runtime ────────────────────────────────────────
const mockBedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn((input) => input),
}));

// ── Mock @modelcontextprotocol/client ───────────────────────────────────────────
const mockConnect = jest.fn();
const mockListTools = jest.fn();
const mockCallTool = jest.fn();
const mockClose = jest.fn();
jest.mock('@modelcontextprotocol/client', () => ({
  Client: jest.fn(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: mockClose,
    getInstructions: jest.fn(() => undefined),
  })),
  StreamableHTTPClientTransport: jest.fn(),
  SSEClientTransport: jest.fn(),
}));

// ── Require handler after mocks are in place ───────────────────────────────────
const { handler } = require('../lambda/chat-handler');

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal fake Lambda event. */
function makeEvent(overrides: Record<string, any> = {}) {
  return {
    headers: { authorization: 'Bearer valid-token' },
    body: JSON.stringify({
      station: 'A1',
      messages: [{ role: 'user', content: 'hello' }],
    }),
    isBase64Encoded: false,
    ...overrides,
  };
}

/** Minimal raw responseStream passed to the handler before HttpResponseStream.from. */
const mockRawStream = { write: jest.fn(), end: jest.fn() };

/** Parse SSE data frames from the accumulated mockStreamWrites. */
function parseSseFrames(writes: string[]) {
  return writes
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, '')));
}

// ── Setup / Teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  mockStreamWrites.length = 0;
  mockStream.end.mockReset();
  mockVerify.mockReset();
  mockBedrockSend.mockReset();
  mockConnect.mockReset();
  mockListTools.mockReset();
  mockCallTool.mockReset();
  mockClose.mockReset();
  delete process.env.MCP_URL_A1;
});

// ── Tests ──────────────────────────────────────────────────────────────────────

test('returns 401 when Authorization header is missing', async () => {
  const streams: Array<{ __meta: { statusCode: number } }> = [];
  const origFrom = (global as any).awslambda.HttpResponseStream.from;
  (global as any).awslambda.HttpResponseStream.from = (
    _stream: any,
    meta: any,
  ) => {
    const s = origFrom(_stream, meta);
    streams.push(s);
    return s;
  };

  await handler(makeEvent({ headers: {} }), mockRawStream);

  (global as any).awslambda.HttpResponseStream.from = origFrom;
  expect(streams.length).toBeGreaterThan(0);
  expect(streams[0].__meta.statusCode).toBe(401);
  // No SSE frames should have been written.
  expect(mockStreamWrites).toHaveLength(0);
});

test('returns 401 when JWT verification fails', async () => {
  mockVerify.mockRejectedValueOnce(new Error('bad signature'));

  const streams: Array<{ __meta: { statusCode: number } }> = [];
  const origFrom = (global as any).awslambda.HttpResponseStream.from;
  (global as any).awslambda.HttpResponseStream.from = (
    _stream: any,
    meta: any,
  ) => {
    const s = origFrom(_stream, meta);
    streams.push(s);
    return s;
  };

  await handler(makeEvent(), mockRawStream);

  (global as any).awslambda.HttpResponseStream.from = origFrom;
  expect(streams.length).toBeGreaterThan(0);
  expect(streams[0].__meta.statusCode).toBe(401);
  expect(mockStreamWrites).toHaveLength(0);
});

test('sends SSE error for unknown station', async () => {
  mockVerify.mockResolvedValueOnce({});
  process.env.MCP_URL_ZZ = 'https://example.com/mcp'; // should never be reached

  await handler(
    makeEvent({
      body: JSON.stringify({ station: 'ZZ', messages: [{ role: 'user', content: 'hi' }] }),
    }),
    mockRawStream,
  );

  delete process.env.MCP_URL_ZZ;
  const frames = parseSseFrames(mockStreamWrites);
  const errFrame = frames.find((f) => f.type === 'error');
  expect(errFrame).toBeDefined();
  expect(errFrame.message).toMatch(/invalid station/i);
});

test('sends SSE error when MCP URL env var is not configured', async () => {
  mockVerify.mockResolvedValueOnce({});
  // MCP_URL_A1 is not set (cleared in beforeEach).

  await handler(makeEvent(), mockRawStream);

  const frames = parseSseFrames(mockStreamWrites);
  const errFrame = frames.find((f) => f.type === 'error');
  expect(errFrame).toBeDefined();
  expect(errFrame.message).toMatch(/not configured/i);
});

test('sends SSE error when messages do not end with a user turn', async () => {
  mockVerify.mockResolvedValueOnce({});
  process.env.MCP_URL_A1 = 'https://example.com/mcp';

  await handler(
    makeEvent({
      body: JSON.stringify({
        station: 'A1',
        messages: [{ role: 'assistant', content: 'hello' }],
      }),
    }),
    mockRawStream,
  );

  const frames = parseSseFrames(mockStreamWrites);
  const errFrame = frames.find((f) => f.type === 'error');
  expect(errFrame).toBeDefined();
  expect(errFrame.message).toMatch(/user turn/i);
});

test('sends SSE error when MCP connect fails on both transports', async () => {
  mockVerify.mockResolvedValueOnce({});
  process.env.MCP_URL_A1 = 'https://example.com/mcp';
  mockConnect.mockRejectedValue(new Error('connection refused'));

  await handler(makeEvent(), mockRawStream);

  const frames = parseSseFrames(mockStreamWrites);
  const errFrame = frames.find((f) => f.type === 'error');
  expect(errFrame).toBeDefined();
});

test('happy path: status → tools → tool_start → tool_result → text → done', async () => {
  mockVerify.mockResolvedValueOnce({});
  process.env.MCP_URL_A1 = 'https://example.com/mcp';
  mockConnect.mockResolvedValue(undefined);
  mockListTools.mockResolvedValueOnce({
    tools: [{ name: 'get_balance', description: 'Returns the account balance.' }],
  });

  // First Converse call → tool_use
  mockBedrockSend.mockResolvedValueOnce({
    output: {
      message: {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 'toolu_abc123',
              name: 'get_balance',
              input: { accountId: 'acc-1' },
            },
          },
        ],
      },
    },
    stopReason: 'tool_use',
  });

  // MCP tool call result
  mockCallTool.mockResolvedValueOnce({
    isError: false,
    content: [{ type: 'text', text: '$1,000.00' }],
  });

  // Second Converse call → end_turn with text
  mockBedrockSend.mockResolvedValueOnce({
    output: {
      message: {
        role: 'assistant',
        content: [{ text: 'Your balance is $1,000.00.' }],
      },
    },
    stopReason: 'end_turn',
  });

  await handler(makeEvent(), mockRawStream);

  const frames = parseSseFrames(mockStreamWrites);
  const types = frames.map((f) => f.type);

  expect(types).toContain('status');
  expect(types).toContain('tools');
  expect(types).toContain('tool_start');
  expect(types).toContain('tool_result');
  expect(types).toContain('text');
  expect(types).toContain('done');

  // Verify ordering: status before tools before tool_start before tool_result before text before done
  const statusIdx = types.indexOf('status');
  const toolsIdx = types.indexOf('tools');
  const toolStartIdx = types.indexOf('tool_start');
  const toolResultIdx = types.indexOf('tool_result');
  const textIdx = types.indexOf('text');
  const doneIdx = types.indexOf('done');
  expect(statusIdx).toBeLessThan(toolsIdx);
  expect(toolsIdx).toBeLessThan(toolStartIdx);
  expect(toolStartIdx).toBeLessThan(toolResultIdx);
  expect(toolResultIdx).toBeLessThan(textIdx);
  expect(textIdx).toBeLessThan(doneIdx);

  // tool_start and tool_result carry the same toolUseId
  const toolStartFrame = frames.find((f) => f.type === 'tool_start');
  const toolResultFrame = frames.find((f) => f.type === 'tool_result');
  expect(toolStartFrame.toolUseId).toBe('toolu_abc123');
  expect(toolResultFrame.toolUseId).toBe('toolu_abc123');

  // text frame carries the assistant reply
  const textFrame = frames.find((f) => f.type === 'text');
  expect(textFrame.content).toBe('Your balance is $1,000.00.');
  expect(textFrame.stopReason).toBe('end_turn');
});
