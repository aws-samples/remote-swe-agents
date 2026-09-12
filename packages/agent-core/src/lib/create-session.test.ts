import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockGetSession = vi.fn();
const mockGetChildSessions = vi.fn();
const mockGetOrCreateWorkerInstance = vi.fn();
const mockUpdateInstanceStatus = vi.fn();
const mockSendWorkerEvent = vi.fn();
const mockGetCustomAgent = vi.fn();
const mockResolveAgentDisplayName = vi.fn();
const mockPostNewSlackThread = vi.fn();
const mockGetWebappSessionUrl = vi.fn();

vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
}));

vi.mock('./sessions', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  getChildSessions: (...args: any[]) => mockGetChildSessions(...args),
}));

vi.mock('./worker-manager', () => ({
  getOrCreateWorkerInstance: (...args: any[]) => mockGetOrCreateWorkerInstance(...args),
  updateInstanceStatus: (...args: any[]) => mockUpdateInstanceStatus(...args),
}));

vi.mock('./events', () => ({
  sendWorkerEvent: (...args: any[]) => mockSendWorkerEvent(...args),
}));

vi.mock('./custom-agent', () => ({
  getCustomAgent: (...args: any[]) => mockGetCustomAgent(...args),
}));

vi.mock('./agent-messaging', () => ({
  resolveAgentDisplayName: (...args: any[]) => mockResolveAgentDisplayName(...args),
}));

vi.mock('./slack', () => ({
  postNewSlackThread: (...args: any[]) => mockPostNewSlackThread(...args),
}));

vi.mock('./webapp-origin', () => ({
  getWebappSessionUrl: (...args: any[]) => mockGetWebappSessionUrl(...args),
}));

// Preserve the real prompt renderer so we can assert on the produced text.
import { createSession } from './create-session';

function getTransactItems(call: any) {
  return call[0]?.input?.TransactItems;
}

describe('createSession', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockGetSession.mockReset();
    mockGetChildSessions.mockReset();
    mockGetChildSessions.mockResolvedValue([]);
    mockGetOrCreateWorkerInstance.mockReset();
    mockGetOrCreateWorkerInstance.mockResolvedValue(undefined);
    mockUpdateInstanceStatus.mockReset();
    mockSendWorkerEvent.mockReset();
    mockSendWorkerEvent.mockResolvedValue(undefined);
    mockGetCustomAgent.mockReset();
    mockGetCustomAgent.mockResolvedValue(undefined);
    mockResolveAgentDisplayName.mockReset();
    mockPostNewSlackThread.mockReset();
    mockGetWebappSessionUrl.mockReset();
    mockGetWebappSessionUrl.mockResolvedValue(undefined);
  });

  test('root session: seed message has no [Message from ...] prefix', async () => {
    await createSession({ message: 'hello there', initiator: 'user-1' });

    const calls = mockSend.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const txItems = getTransactItems(calls[0]);
    expect(txItems).toBeDefined();
    const messageItem = txItems.find((i: any) => i.Put.Item.PK.startsWith('message-'));
    expect(messageItem).toBeDefined();
    const content = JSON.parse(messageItem.Put.Item.content);
    const text = content[0].text as string;
    expect(text).toContain('hello there');
    expect(text).not.toContain('[Message from');
  });

  test('child session: seed message is wrapped with [Message from <parentName> (<parentId>)]', async () => {
    mockGetSession.mockResolvedValueOnce({
      PK: 'sessions',
      SK: 'session-parent',
      workerId: 'session-parent',
      agentName: 'Remote SWE PM',
    });
    mockResolveAgentDisplayName.mockResolvedValueOnce('Remote SWE PM');

    await createSession({
      message: 'please implement feature X',
      initiator: 'agent-parent',
      parentSessionId: 'session-parent',
    });

    const calls = mockSend.mock.calls;
    const txItems = getTransactItems(calls[0]);
    const messageItem = txItems.find((i: any) => i.Put.Item.PK.startsWith('message-'));
    const content = JSON.parse(messageItem.Put.Item.content);
    const text = content[0].text as string;

    expect(text).toContain('[Message from Remote SWE PM (session-parent)]: please implement feature X');
    // Should still carry the agent-message envelope telling the child to
    // reply via sendMessageToAgent.
    expect(text).toContain('sendMessageToAgent');
    expect(text).toContain('session-parent');
  });

  test('child session: falls back to "parent" placeholder when parent name cannot be resolved', async () => {
    mockGetSession.mockResolvedValueOnce(undefined);

    await createSession({
      message: 'kickoff',
      initiator: 'agent-parent',
      parentSessionId: 'session-missing',
    });

    const calls = mockSend.mock.calls;
    const txItems = getTransactItems(calls[0]);
    const messageItem = txItems.find((i: any) => i.Put.Item.PK.startsWith('message-'));
    const content = JSON.parse(messageItem.Put.Item.content);
    const text = content[0].text as string;

    expect(text).toContain('[Message from parent (session-missing)]: kickoff');
  });

  test('root session with webapp sender: embeds [from: ...] header AND persists senderDisplayName/senderType', async () => {
    await createSession({
      message: "Hi I'm Alice",
      initiator: 'webapp#user-alice',
      senderUserId: 'user-alice',
      senderType: 'webapp',
      senderDisplayName: 'alice',
    });

    const calls = mockSend.mock.calls;
    const txItems = getTransactItems(calls[0]);
    const messageItem = txItems.find((i: any) => i.Put.Item.PK.startsWith('message-'));

    // Envelope header injected into the prompt text.
    const content = JSON.parse(messageItem.Put.Item.content);
    const text = content[0].text as string;
    expect(text).toContain('[from: alice (webapp)]');
    expect(text).toContain("Hi I'm Alice");
    // No child-session prefix on a root session.
    expect(text).not.toContain('[Message from');

    // Sender attributes persisted on the item so the webapp UI can render
    // "alice" without re-parsing the envelope.
    expect(messageItem.Put.Item.senderDisplayName).toBe('alice');
    expect(messageItem.Put.Item.senderType).toBe('webapp');
    expect(messageItem.Put.Item.senderUserId).toBe('user-alice');
  });

  test('root session with slack sender: embeds [from: ...] header with (slack) type', async () => {
    await createSession({
      message: 'hello from slack',
      initiator: 'slack#U123',
      senderUserId: 'U123',
      senderType: 'slack',
      senderDisplayName: 'slack-bob',
    });

    const calls = mockSend.mock.calls;
    const txItems = getTransactItems(calls[0]);
    const messageItem = txItems.find((i: any) => i.Put.Item.PK.startsWith('message-'));
    const content = JSON.parse(messageItem.Put.Item.content);
    const text = content[0].text as string;

    expect(text).toContain('[from: slack-bob (slack)]');
    expect(messageItem.Put.Item.senderType).toBe('slack');
  });

  test('root session without sender info: no envelope header, no senderType/senderDisplayName persisted', async () => {
    await createSession({
      message: 'api request',
      initiator: 'rest#',
    });

    const calls = mockSend.mock.calls;
    const txItems = getTransactItems(calls[0]);
    const messageItem = txItems.find((i: any) => i.Put.Item.PK.startsWith('message-'));
    const content = JSON.parse(messageItem.Put.Item.content);
    const text = content[0].text as string;

    // Envelope has no [from: ...] header — backward-compat / REST API path.
    expect(text).not.toMatch(/\[from:/);
    // Item has neither senderType nor senderDisplayName.
    expect(messageItem.Put.Item.senderType).toBeUndefined();
    expect(messageItem.Put.Item.senderDisplayName).toBeUndefined();
  });

  test('child session: senderType is NOT propagated to the stored item (child prefix is authoritative)', async () => {
    mockGetSession.mockResolvedValueOnce({
      PK: 'sessions',
      SK: 'session-parent',
      workerId: 'session-parent',
      agentName: 'PM',
    });
    mockResolveAgentDisplayName.mockResolvedValueOnce('PM');

    await createSession({
      message: 'sub-task',
      initiator: 'agent-parent',
      parentSessionId: 'session-parent',
      // A misbehaving caller shouldn't be able to tag a child session's
      // seed item with `senderType: 'webapp'` — the child path uses the
      // `[Message from ...]` prefix and its own agent-message envelope.
      senderType: 'webapp',
      senderDisplayName: 'impostor',
    });

    const calls = mockSend.mock.calls;
    const txItems = getTransactItems(calls[0]);
    const messageItem = txItems.find((i: any) => i.Put.Item.PK.startsWith('message-'));

    expect(messageItem.Put.Item.senderType).toBeUndefined();
    expect(messageItem.Put.Item.senderDisplayName).toBeUndefined();
    // And the envelope still has the agent-message prefix rather than the
    // webapp `[from: ...]` header.
    const content = JSON.parse(messageItem.Put.Item.content);
    const text = content[0].text as string;
    expect(text).toContain('[Message from PM (session-parent)]:');
    expect(text).not.toContain('[from: impostor');
  });
});
