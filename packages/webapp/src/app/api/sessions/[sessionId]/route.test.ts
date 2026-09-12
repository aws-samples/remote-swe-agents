import { describe, expect, test, vi, beforeEach } from 'vitest';

// Mocks for all agent-core hooks that the route imports. Each test sets the
// return values it needs in `beforeEach`; the route then invokes them via
// the live function references.
const mockGetSession = vi.fn();
const mockSendWebappEvent = vi.fn();
const mockSendWorkerEvent = vi.fn();
const mockGetOrCreateWorkerInstance = vi.fn();
const mockGetConversationHistory = vi.fn();
const mockNoOpFiltering = vi.fn();
const mockDdbSend = vi.fn();
const mockAuthenticateApiKey = vi.fn();
const mockValidateApiKeyMiddleware = vi.fn();

vi.mock('@remote-swe-agents/agent-core/lib', async () => {
  // Pull the real `renderUserMessage` so we exercise the full envelope
  // contract — the route must wrap the message body with the actual
  // `[from: ...]` header that the worker LLM expects to see.
  const actual: any = await vi.importActual('@remote-swe-agents/agent-core/lib');
  return {
    ...actual,
    getSession: (...args: any[]) => mockGetSession(...args),
    sendWebappEvent: (...args: any[]) => mockSendWebappEvent(...args),
    sendWorkerEvent: (...args: any[]) => mockSendWorkerEvent(...args),
    getOrCreateWorkerInstance: (...args: any[]) => mockGetOrCreateWorkerInstance(...args),
    getConversationHistory: (...args: any[]) => mockGetConversationHistory(...args),
    noOpFiltering: (...args: any[]) => mockNoOpFiltering(...args),
  };
});

vi.mock('@remote-swe-agents/agent-core/aws', () => ({
  ddb: { send: (...args: any[]) => mockDdbSend(...args) },
  TableName: 'test-table',
}));

vi.mock('../../auth/api-key', () => ({
  authenticateApiKey: (...args: any[]) => mockAuthenticateApiKey(...args),
  validateApiKeyMiddleware: (...args: any[]) => mockValidateApiKeyMiddleware(...args),
}));

import { POST } from './route';

function buildRequest(body: unknown): any {
  // The route only uses `request.json()` and `request.headers.get('x-api-key')`
  // (indirectly via `authenticateApiKey`, which is mocked). A minimal stub
  // suffices — we do not need to involve a real `NextRequest`.
  return {
    json: async () => body,
    headers: { get: () => 'fake-api-key' },
  };
}

describe('POST /api/sessions/[sessionId] sender attribution', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockSendWebappEvent.mockReset().mockResolvedValue(undefined);
    mockSendWorkerEvent.mockReset().mockResolvedValue(undefined);
    mockGetOrCreateWorkerInstance.mockReset().mockResolvedValue(undefined);
    mockDdbSend.mockReset().mockResolvedValue({});
    mockAuthenticateApiKey.mockReset();
  });

  test('persists senderType=apikey and the API key id/displayName on the message item', async () => {
    mockAuthenticateApiKey.mockResolvedValueOnce({
      ok: true,
      sender: { id: 'apikey-deadbeef0001', displayName: 'CI deploy bot', ownerId: 'owner-1' },
    });
    mockGetSession.mockResolvedValueOnce({ runtimeType: 'ec2' });

    const res = await POST(buildRequest({ message: 'kick off deploy' }), {
      params: Promise.resolve({ sessionId: 'sess-1' }),
    });
    expect(res.status).toBe(200);

    // The route writes the message item with PutCommand. Find that call.
    const putCalls = mockDdbSend.mock.calls.filter((c) => c[0]?.input?.Item?.PK?.startsWith?.('message-'));
    expect(putCalls.length).toBe(1);
    const item = putCalls[0][0].input.Item;

    // Sender attribution must be persisted so subsequent reads round-trip
    // through `page.tsx` and `MessageList` grouping correctly.
    expect(item.senderType).toBe('apikey');
    expect(item.senderUserId).toBe('apikey-deadbeef0001');
    expect(item.senderDisplayName).toBe('CI deploy bot');
    expect(item.role).toBe('user');
    expect(item.messageType).toBe('userMessage');
  });

  test('wraps the message body with the [from: ... (apikey)] LLM envelope', async () => {
    mockAuthenticateApiKey.mockResolvedValueOnce({
      ok: true,
      sender: { id: 'apikey-feedface0002', displayName: 'CI deploy bot', ownerId: 'owner-1' },
    });
    mockGetSession.mockResolvedValueOnce({ runtimeType: 'ec2' });

    await POST(buildRequest({ message: 'hello world' }), {
      params: Promise.resolve({ sessionId: 'sess-2' }),
    });

    const putCalls = mockDdbSend.mock.calls.filter((c) => c[0]?.input?.Item?.PK?.startsWith?.('message-'));
    const item = putCalls[0][0].input.Item;
    const content = JSON.parse(item.content);
    const text: string = content[0].text;

    // The LLM-side envelope must carry the API-key sender header so the
    // worker model can attribute the message correctly when multiple
    // sources contribute to the same session.
    expect(text).toContain('[from: CI deploy bot (apikey)]\n');
    expect(text).toContain('hello world');
    expect(text).toContain('<user_message>');
    expect(text).toContain('</user_message>');
  });

  test('emits the rebroadcast event with senderType=apikey + the key id/displayName', async () => {
    mockAuthenticateApiKey.mockResolvedValueOnce({
      ok: true,
      sender: { id: 'apikey-cafefeed0003', displayName: 'release-bot', ownerId: 'owner-2' },
    });
    mockGetSession.mockResolvedValueOnce({ runtimeType: 'ec2' });

    await POST(buildRequest({ message: 'deploy v2' }), {
      params: Promise.resolve({ sessionId: 'sess-3' }),
    });

    // Find the 'message' rebroadcast event among the sendWebappEvent calls.
    const messageEvents = mockSendWebappEvent.mock.calls.filter((c) => c[1]?.type === 'message');
    expect(messageEvents.length).toBe(1);
    const event = messageEvents[0][1];
    expect(event.senderType).toBe('apikey');
    expect(event.senderUserId).toBe('apikey-cafefeed0003');
    expect(event.senderDisplayName).toBe('release-bot');
    expect(event.role).toBe('user');
    expect(event.message).toBe('deploy v2');
  });

  test('returns 401 from authenticateApiKey when the key is missing/invalid', async () => {
    mockAuthenticateApiKey.mockResolvedValueOnce({
      ok: false,
      response: { status: 401 },
    });

    const res = await POST(buildRequest({ message: 'x' }), {
      params: Promise.resolve({ sessionId: 'sess-4' }),
    });
    expect((res as any).status).toBe(401);
    // Crucially, no DDB write happened.
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('returns 404 when the session does not exist', async () => {
    mockAuthenticateApiKey.mockResolvedValueOnce({
      ok: true,
      sender: { id: 'apikey-x', displayName: 'x' },
    });
    mockGetSession.mockResolvedValueOnce(null);

    const res = await POST(buildRequest({ message: 'x' }), {
      params: Promise.resolve({ sessionId: 'missing' }),
    });
    expect(res.status).toBe(404);
  });
});
