import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { SessionItem } from '../schema';

const mockSend = vi.fn();
const mockGetSession = vi.fn();
const mockGetOrCreateWorkerInstance = vi.fn();
const mockSendWorkerEvent = vi.fn();
const mockSendWebappEvent = vi.fn();
const mockGetCustomAgent = vi.fn();
const mockGetPreferences = vi.fn();

vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
}));

vi.mock('./sessions', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  updateSessionLastMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./worker-manager', () => ({
  getOrCreateWorkerInstance: (...args: any[]) => mockGetOrCreateWorkerInstance(...args),
}));

vi.mock('./events', () => ({
  sendWorkerEvent: (...args: any[]) => mockSendWorkerEvent(...args),
  sendWebappEvent: (...args: any[]) => mockSendWebappEvent(...args),
}));

vi.mock('./custom-agent', () => ({
  getCustomAgent: (...args: any[]) => mockGetCustomAgent(...args),
}));

vi.mock('./preferences', () => ({
  getPreferences: (...args: any[]) => mockGetPreferences(...args),
}));

vi.mock('./prompt', () => ({
  renderAgentMessage: ({ message }: { message: string }) => message,
  // `sendAgentMessage` now calls `sanitizeSenderLabel` to defensively
  // sanitise the sender name / id that are embedded in the inline
  // `[Message from ... (...)]:` prefix. The real sanitiser is covered by
  // prompt.test.ts; here we just keep the value unchanged so the existing
  // assertions on item PKs, message types, etc. remain meaningful.
  sanitizeSenderLabel: (s: string) => s,
}));

const mockGetRecentMessages = vi.fn();
vi.mock('./messages', () => ({
  getRecentMessages: (...args: any[]) => mockGetRecentMessages(...args),
}));

import { sendAgentMessage } from './agent-messaging';

const buildSession = (id: string, extra: Partial<SessionItem> = {}): SessionItem =>
  ({
    PK: 'sessions',
    SK: id,
    agentName: `agent-${id}`,
    ...extra,
  }) as SessionItem;

describe('sendAgentMessage', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockGetSession.mockReset();
    mockGetOrCreateWorkerInstance.mockReset();
    mockSendWorkerEvent.mockReset();
    mockSendWebappEvent.mockReset();
    mockGetCustomAgent.mockReset();
    mockGetPreferences.mockReset();

    mockGetPreferences.mockResolvedValue({});
    mockSend.mockResolvedValue({});
    mockGetOrCreateWorkerInstance.mockResolvedValue({});
    mockSendWorkerEvent.mockResolvedValue({});
    mockSendWebappEvent.mockResolvedValue({});
    mockGetRecentMessages.mockReset();
    mockGetRecentMessages.mockResolvedValue([]);
  });

  test('sibling-to-sibling: parent history entry uses communicationLog messageType', async () => {
    const sender = buildSession('child-a', { parentSessionId: 'parent-1' });
    const target = buildSession('child-b', { parentSessionId: 'parent-1' });

    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'child-a') return sender;
      if (id === 'child-b') return target;
      return null;
    });

    await sendAgentMessage({
      senderWorkerId: 'child-a',
      targetSessionIds: ['child-b'],
      message: 'hello sibling',
    });

    const putCalls = mockSend.mock.calls.map((c) => c[0]).filter((cmd) => cmd?.constructor?.name === 'PutCommand');

    // 3 puts: target agentMessage + parent communicationLog + sender communicationLog
    expect(putCalls.length).toBe(3);

    const directItem = putCalls.find((c) => c.input.Item.PK === 'message-child-b')?.input.Item;
    const parentItem = putCalls.find((c) => c.input.Item.PK === 'message-parent-1')?.input.Item;
    const senderItem = putCalls.find((c) => c.input.Item.PK === 'message-child-a')?.input.Item;

    expect(directItem).toBeDefined();
    expect(parentItem).toBeDefined();
    expect(senderItem).toBeDefined();

    expect(directItem.messageType).toBe('agentMessage');

    expect(parentItem.messageType).toBe('communicationLog');
    expect(parentItem.senderSessionId).toBe('child-a');
    expect(parentItem.targetSessionId).toBe('child-b');

    expect(senderItem.messageType).toBe('communicationLog');

    // webapp events: one to parent (communication log), one to sender, one to target (W-A1).
    // NO lastMessageUpdate — agent-to-agent messages must not reorder/re-preview the session list.
    const webappCalls = mockSendWebappEvent.mock.calls;
    const agentMsgCalls = webappCalls.filter((c: any[]) => c[1].type === 'agentMessage');
    const lastMsgCalls = webappCalls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(agentMsgCalls.length).toBe(3);
    expect(agentMsgCalls.map((c: any[]) => c[0]).sort()).toEqual(['child-a', 'child-b', 'parent-1']);
    expect(lastMsgCalls.length).toBe(0);
  });

  test('child-to-parent: no mirror write (target IS the parent)', async () => {
    const sender = buildSession('child-a', { parentSessionId: 'parent-1' });
    const target = buildSession('parent-1');

    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'child-a') return sender;
      if (id === 'parent-1') return target;
      return null;
    });

    await sendAgentMessage({
      senderWorkerId: 'child-a',
      targetSessionIds: ['parent-1'],
      message: 'report to parent',
    });

    const putCalls = mockSend.mock.calls.map((c) => c[0]).filter((cmd) => cmd?.constructor?.name === 'PutCommand');

    // 2 puts: direct agentMessage to parent + sender communicationLog
    // No separate parent mirror because target === parentSessionId.
    expect(putCalls.length).toBe(2);
    expect(putCalls[0].input.Item.PK).toBe('message-parent-1');
    expect(putCalls[0].input.Item.messageType).toBe('agentMessage');
    expect(putCalls[1].input.Item.PK).toBe('message-child-a');
    expect(putCalls[1].input.Item.messageType).toBe('communicationLog');

    // webapp events: one to parent (real-time notification), one to sender. No lastMessageUpdate.
    const webappCalls = mockSendWebappEvent.mock.calls;
    const agentMsgCalls = webappCalls.filter((c: any[]) => c[1].type === 'agentMessage');
    const lastMsgCalls = webappCalls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(agentMsgCalls.length).toBe(2);
    expect(agentMsgCalls.map((c: any[]) => c[0]).sort()).toEqual(['child-a', 'parent-1']);
    expect(lastMsgCalls.length).toBe(0);
  });

  test('top-level-to-top-level: no parent mirror when neither session has a parent', async () => {
    const sender = buildSession('top-a');
    const target = buildSession('top-b');

    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'top-a') return sender;
      if (id === 'top-b') return target;
      return null;
    });

    await sendAgentMessage({
      senderWorkerId: 'top-a',
      targetSessionIds: ['top-b'],
      message: 'hi',
    });

    const putCalls = mockSend.mock.calls.map((c) => c[0]).filter((cmd) => cmd?.constructor?.name === 'PutCommand');

    expect(putCalls.length).toBe(2);
    expect(putCalls[0].input.Item.PK).toBe('message-top-b');
    expect(putCalls[0].input.Item.messageType).toBe('agentMessage');
    expect(putCalls[1].input.Item.PK).toBe('message-top-a');
    expect(putCalls[1].input.Item.messageType).toBe('communicationLog');

    // webapp event: sender + target (no parent exists). No lastMessageUpdate.
    const webappCalls = mockSendWebappEvent.mock.calls;
    const agentMsgCalls = webappCalls.filter((c: any[]) => c[1].type === 'agentMessage');
    const lastMsgCalls = webappCalls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(agentMsgCalls.length).toBe(2);
    expect(agentMsgCalls.map((c: any[]) => c[0]).sort()).toEqual(['top-a', 'top-b']);
    expect(lastMsgCalls.length).toBe(0);
  });

  test('parent-to-child: no duplicate communicationLog in sender (parent) history', async () => {
    const sender = buildSession('parent-1');
    const target = buildSession('child-a', { parentSessionId: 'parent-1' });

    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'parent-1') return sender;
      if (id === 'child-a') return target;
      return null;
    });

    await sendAgentMessage({
      senderWorkerId: 'parent-1',
      targetSessionIds: ['child-a'],
      message: 'task for you',
    });

    const putCalls = mockSend.mock.calls.map((c) => c[0]).filter((cmd) => cmd?.constructor?.name === 'PutCommand');

    // Expect exactly 2 puts:
    // 1. agentMessage to target (child-a)
    // 2. sender communicationLog (parent-1)
    // The parent communicationLog must NOT be written because parentSessionId === senderWorkerId
    // (would cause duplicate entry in parent's own history).
    expect(putCalls.length).toBe(2);

    const targetItem = putCalls.find((c) => c.input.Item.PK === 'message-child-a')?.input.Item;
    expect(targetItem).toBeDefined();
    expect(targetItem.messageType).toBe('agentMessage');

    const senderItems = putCalls.filter((c) => c.input.Item.PK === 'message-parent-1');
    expect(senderItems.length).toBe(1);
    expect(senderItems[0].input.Item.messageType).toBe('communicationLog');

    // sendWebappEvent: agentMessage to sender (parent-1) + target (child-a).
    // Parent block doesn't fire because parentSessionId === senderWorkerId.
    // No lastMessageUpdate for agent-to-agent messages.
    const webappCalls = mockSendWebappEvent.mock.calls;
    const agentMsgCalls = webappCalls.filter((c: any[]) => c[1].type === 'agentMessage');
    const lastMsgCalls = webappCalls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(agentMsgCalls.length).toBe(2);
    expect(agentMsgCalls.map((c: any[]) => c[0]).sort()).toEqual(['child-a', 'parent-1']);
    expect(lastMsgCalls.length).toBe(0);
  });
});

describe('sendAgentMessage — duplicate ack suppression (auto-retrigger re-ack)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockGetSession.mockReset();
    mockGetOrCreateWorkerInstance.mockReset();
    mockSendWorkerEvent.mockReset();
    mockSendWebappEvent.mockReset();
    mockGetCustomAgent.mockReset();
    mockGetPreferences.mockReset();
    mockGetRecentMessages.mockReset();

    mockGetPreferences.mockResolvedValue({});
    mockSend.mockResolvedValue({});
    mockGetOrCreateWorkerInstance.mockResolvedValue({});
    mockSendWorkerEvent.mockResolvedValue({});
    mockSendWebappEvent.mockResolvedValue({});

    const sender = buildSession('child-a', { parentSessionId: 'parent-1' });
    const target = buildSession('child-b', { parentSessionId: 'parent-1' });
    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'child-a') return sender;
      if (id === 'child-b') return target;
      return null;
    });
  });

  // Japanese ack fixtures ("了解です" = "understood", "進めてください" = "please
  // proceed") are intentional: the ack-dedup path normalises CJK text and the
  // observed production symptom involved Japanese acknowledgements.
  const priorAckLog = (text: string, sk: number) => [
    {
      PK: 'message-child-a',
      SK: String(sk).padStart(15, '0'),
      content: JSON.stringify([{ text }]),
      messageType: 'communicationLog',
      senderSessionId: 'child-a',
      targetSessionId: 'child-b',
    },
  ];

  const putCount = () =>
    mockSend.mock.calls.map((c) => c[0]).filter((cmd) => cmd?.constructor?.name === 'PutCommand').length;

  test('suppresses an identical ack already sent to the same target (no DDB writes)', async () => {
    mockGetRecentMessages.mockResolvedValue(priorAckLog('了解です', Date.now() - 1000) as any);
    const res = await sendAgentMessage({
      senderWorkerId: 'child-a',
      targetSessionIds: ['child-b'],
      message: '了解です',
      acknowledge: true,
    });
    // Reported as a successful no-op, but nothing was delivered/persisted.
    expect(res.sent).toContain('child-b');
    expect(putCount()).toBe(0);
    expect(mockSendWorkerEvent).not.toHaveBeenCalled();
  });

  test('delivers a genuinely different ack to the same target', async () => {
    mockGetRecentMessages.mockResolvedValue(priorAckLog('了解です', Date.now() - 1000) as any);
    const res = await sendAgentMessage({
      senderWorkerId: 'child-a',
      targetSessionIds: ['child-b'],
      message: '進めてください',
      acknowledge: true,
    });
    expect(res.sent).toContain('child-b');
    expect(putCount()).toBeGreaterThan(0);
  });

  test('a non-ack short message is NOT suppressed even if identical (acknowledge=false)', async () => {
    mockGetRecentMessages.mockResolvedValue(priorAckLog('了解です', Date.now() - 1000) as any);
    const res = await sendAgentMessage({
      senderWorkerId: 'child-a',
      targetSessionIds: ['child-b'],
      message: '了解です',
      acknowledge: false,
    });
    expect(res.sent).toContain('child-b');
    expect(putCount()).toBeGreaterThan(0);
  });

  test('identical ack outside the window is delivered', async () => {
    const sixMinAgo = Date.now() - 6 * 60 * 1000;
    mockGetRecentMessages.mockResolvedValue(priorAckLog('了解です', sixMinAgo) as any);
    const res = await sendAgentMessage({
      senderWorkerId: 'child-a',
      targetSessionIds: ['child-b'],
      message: '了解です',
      acknowledge: true,
    });
    expect(res.sent).toContain('child-b');
    expect(putCount()).toBeGreaterThan(0);
  });
});

describe('sendAgentMessage — lastMessageUpdate suppression (agent-to-agent is internal)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockGetSession.mockReset();
    mockGetOrCreateWorkerInstance.mockReset();
    mockSendWorkerEvent.mockReset();
    mockSendWebappEvent.mockReset();
    mockGetCustomAgent.mockReset();
    mockGetPreferences.mockReset();

    mockGetPreferences.mockResolvedValue({});
    mockSend.mockResolvedValue({});
    mockGetOrCreateWorkerInstance.mockResolvedValue({});
    mockSendWorkerEvent.mockResolvedValue({});
    mockSendWebappEvent.mockResolvedValue({});
    mockGetRecentMessages.mockReset();
    mockGetRecentMessages.mockResolvedValue([]);
  });

  test('non-ack sibling message: NO lastMessageUpdate to target, sender, or parent', async () => {
    const sender = buildSession('child-a', { parentSessionId: 'parent-1' });
    const target = buildSession('child-b', { parentSessionId: 'parent-1' });

    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'child-a') return sender;
      if (id === 'child-b') return target;
      return null;
    });

    await sendAgentMessage({
      senderWorkerId: 'child-a',
      targetSessionIds: ['child-b'],
      message: 'hello sibling',
    });

    // Agent-to-agent chatter must not reorder or re-preview the session list.
    const lastMsgCalls = mockSendWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(lastMsgCalls.length).toBe(0);

    // But the real-time agentMessage bubbles are still delivered to all 3.
    const agentMsgCalls = mockSendWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'agentMessage');
    expect(agentMsgCalls.length).toBe(3);
    expect(agentMsgCalls.map((c: any[]) => c[0]).sort()).toEqual(['child-a', 'child-b', 'parent-1']);
  });

  test('child-to-parent: emits NO lastMessageUpdate', async () => {
    const sender = buildSession('child-a', { parentSessionId: 'parent-1' });
    const target = buildSession('parent-1');

    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'child-a') return sender;
      if (id === 'parent-1') return target;
      return null;
    });

    await sendAgentMessage({
      senderWorkerId: 'child-a',
      targetSessionIds: ['parent-1'],
      message: 'report to parent',
    });

    const lastMsgCalls = mockSendWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(lastMsgCalls.length).toBe(0);

    // W-A1 dedup guard on the agentMessage path is unchanged: 2 (sender + parent/target), NOT 3.
    const agentMsgCalls = mockSendWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'agentMessage');
    expect(agentMsgCalls.length).toBe(2);
    expect(agentMsgCalls.map((c: any[]) => c[0]).sort()).toEqual(['child-a', 'parent-1']);
  });

  test('parent-to-child: emits NO lastMessageUpdate', async () => {
    const sender = buildSession('parent-1');
    const target = buildSession('child-a', { parentSessionId: 'parent-1' });

    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'parent-1') return sender;
      if (id === 'child-a') return target;
      return null;
    });

    await sendAgentMessage({
      senderWorkerId: 'parent-1',
      targetSessionIds: ['child-a'],
      message: 'task for you',
    });

    const lastMsgCalls = mockSendWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(lastMsgCalls.length).toBe(0);
  });

  test('non-ack top-level message: NO lastMessageUpdate and NO DDB lastMessage update', async () => {
    const { updateSessionLastMessage: mockUpdateLastMsg } = await import('./sessions');
    (mockUpdateLastMsg as ReturnType<typeof vi.fn>).mockClear();

    const sender = buildSession('top-a');
    const target = buildSession('top-b');

    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'top-a') return sender;
      if (id === 'top-b') return target;
      return null;
    });

    await sendAgentMessage({
      senderWorkerId: 'top-a',
      targetSessionIds: ['top-b'],
      message: 'test message',
    });

    const lastMsgCalls = mockSendWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(lastMsgCalls.length).toBe(0);

    // DDB lastMessage/lastMessageAt must NOT be touched for either session.
    expect(mockUpdateLastMsg).not.toHaveBeenCalled();
  });

  test('acknowledge=true: NO lastMessageUpdate and NO DDB lastMessage update (unchanged ack behaviour)', async () => {
    const { updateSessionLastMessage: mockUpdateLastMsg } = await import('./sessions');
    (mockUpdateLastMsg as ReturnType<typeof vi.fn>).mockClear();

    const sender = buildSession('child-a', { parentSessionId: 'parent-1' });
    const target = buildSession('child-b', { parentSessionId: 'parent-1' });

    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'child-a') return sender;
      if (id === 'child-b') return target;
      return null;
    });

    await sendAgentMessage({
      senderWorkerId: 'child-a',
      targetSessionIds: ['child-b'],
      message: 'Got it, working on it.',
      acknowledge: true,
    });

    // agentMessage events still emitted (bubble delivery intact)
    const agentMsgCalls = mockSendWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'agentMessage');
    expect(agentMsgCalls.length).toBeGreaterThan(0);

    const lastMsgCalls = mockSendWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(lastMsgCalls.length).toBe(0);

    expect(mockUpdateLastMsg).not.toHaveBeenCalled();
  });
});
