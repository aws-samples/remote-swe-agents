import { describe, expect, test, vi, beforeEach } from 'vitest';
import { globalPreferencesSchema } from '../../schema';

const mockGetSession = vi.fn();
const mockGetConversationHistory = vi.fn();
const mockSendMessageToSlack = vi.fn();
const mockUpdateSessionLastMessage = vi.fn();
const mockSendWebappEvent = vi.fn();
const mockSendPushNotificationToUser = vi.fn();
const mockIncrementUnread = vi.fn();
const mockShouldSuppressUserDelivery = vi.fn();
const mockRecordUserDelivery = vi.fn();

vi.mock('../../lib/sessions', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  updateSessionLastMessage: (...args: any[]) => mockUpdateSessionLastMessage(...args),
}));

vi.mock('../../lib/messages', () => ({
  getConversationHistory: (...args: any[]) => mockGetConversationHistory(...args),
}));

vi.mock('../../lib/slack', () => ({
  sendMessageToSlack: (...args: any[]) => mockSendMessageToSlack(...args),
}));

vi.mock('../../lib/events', () => ({
  sendWebappEvent: (...args: any[]) => mockSendWebappEvent(...args),
}));

vi.mock('../../lib/push-notification', () => ({
  sendPushNotificationToUser: (...args: any[]) => mockSendPushNotificationToUser(...args),
  resolveNotificationAgentName: (opts: {
    customAgentId?: string;
    customAgentName?: string;
    sessionAgentName?: string;
    defaultAgentName?: string;
  }) => {
    if (opts.customAgentId && opts.customAgentName) return opts.customAgentName;
    return opts.sessionAgentName || opts.defaultAgentName || 'Agent';
  },
}));

vi.mock('../../lib/preferences', () => ({
  getPreferences: async () => ({ defaultAgentName: '' }),
}));

vi.mock('../../lib/unread', () => ({
  incrementUnread: (...args: any[]) => mockIncrementUnread(...args),
}));

vi.mock('../../lib/user-delivery-dedup', () => ({
  shouldSuppressUserDelivery: (...args: any[]) => mockShouldSuppressUserDelivery(...args),
  recordUserDelivery: (...args: any[]) => mockRecordUserDelivery(...args),
}));

import { reportProgressTool } from './index';
import { confirmSendToUserTool, loadAndDeletePendingUserMessage } from '../confirm-send-to-user';

const mockContext = {
  workerId: 'test-worker-123',
  toolUseId: 'test-tool-use',
  globalPreferences: globalPreferencesSchema.parse({
    PK: 'global-config',
    SK: 'general',
  }),
};

describe('sendMessageToUser child session confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('parent session sends message directly without confirmation', async () => {
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });

    const result = await reportProgressTool.handler({ message: 'hello user' }, mockContext);

    expect(result).toBe('Successfully sent a message.');
    expect(mockSendMessageToSlack).toHaveBeenCalledWith('hello user');
  });

  test('child session with triggering message as userMessage sends directly', async () => {
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [
        { messageType: 'agentMessage', senderAgentName: 'PM' },
        { messageType: 'userMessage' },
        { messageType: 'assistant' },
        { messageType: 'toolUse' },
      ],
    });

    const result = await reportProgressTool.handler({ message: 'reply to user' }, mockContext);

    expect(result).toBe('Successfully sent a message.');
    expect(mockSendMessageToSlack).toHaveBeenCalledWith('reply to user');
  });

  test('child session with triggering message as agentMessage and user messages returns strong warning with confirmSendToUser', async () => {
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [
        { messageType: 'userMessage' },
        { messageType: 'agentMessage', senderAgentName: 'PM Agent' },
        { messageType: 'assistant' },
        { messageType: 'toolUse' },
        { messageType: 'toolResult' },
        { messageType: 'toolUse' },
      ],
    });

    const result = await reportProgressTool.handler({ message: 'blocked message' }, mockContext);

    expect(result).toContain('WARNING');
    expect(result).toContain('99%');
    expect(result).toContain('Messages from user in this session: 1');
    expect(result).toContain('agentMessage (PM Agent)');
    expect(result).toContain('confirmSendToUser');
    expect(result).toContain('ABSOLUTELY CERTAIN');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });

  test('child session with triggering message as eventTrigger and no user messages returns hard error', async () => {
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [{ messageType: 'eventTrigger' }, { messageType: 'assistant' }, { messageType: 'toolUse' }],
    });

    const result = await reportProgressTool.handler({ message: 'event response' }, mockContext);

    expect(result).toContain('ERROR');
    expect(result).toContain('not available');
    expect(result).toContain('0 user messages');
    expect(result).toContain('sendMessageToAgent');
    expect(result).toContain('Do NOT call confirmSendToUser');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });

  test('skips toolUse/toolResult/assistant/errorFeedback to find triggering message (no user messages = error)', async () => {
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [
        { messageType: 'agentMessage', senderAgentName: 'Parent' },
        { messageType: 'assistant' },
        { messageType: 'toolUse' },
        { messageType: 'toolResult' },
        { messageType: 'assistant' },
        { messageType: 'toolUse' },
        { messageType: 'toolResult' },
        { messageType: 'errorFeedback' },
        { messageType: 'toolUse' },
      ],
    });

    const result = await reportProgressTool.handler({ message: 'tool done' }, mockContext);

    expect(result).toContain('ERROR');
    expect(result).toContain('not available');
    expect(result).toContain('0 user messages');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });

  test('skips toolUse/toolResult/assistant/errorFeedback to find triggering message (has user messages = warning)', async () => {
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [
        { messageType: 'userMessage' },
        { messageType: 'assistant' },
        { messageType: 'agentMessage', senderAgentName: 'Parent' },
        { messageType: 'assistant' },
        { messageType: 'toolUse' },
        { messageType: 'toolResult' },
        { messageType: 'assistant' },
        { messageType: 'toolUse' },
        { messageType: 'toolResult' },
        { messageType: 'errorFeedback' },
        { messageType: 'toolUse' },
      ],
    });

    const result = await reportProgressTool.handler({ message: 'tool done' }, mockContext);

    expect(result).toContain('WARNING');
    expect(result).toContain('99%');
    expect(result).toContain('agentMessage (Parent)');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });

  test('child session with empty items returns hard error (no user messages)', async () => {
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [],
    });

    const result = await reportProgressTool.handler({ message: 'empty history' }, mockContext);

    expect(result).toContain('ERROR');
    expect(result).toContain('not available');
    expect(result).toContain('0 user messages');
    expect(result).toContain('Do NOT call confirmSendToUser');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });

  test('session without parentSessionId (null) sends directly', async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await reportProgressTool.handler({ message: 'no session' }, mockContext);

    expect(result).toBe('Successfully sent a message.');
    expect(mockSendMessageToSlack).toHaveBeenCalled();
  });
});

describe('confirmSendToUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('sends the blocked message when called', async () => {
    // First block a message (Case 2: has user messages but non-user trigger)
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [{ messageType: 'userMessage' }, { messageType: 'agentMessage', senderAgentName: 'PM' }],
    });

    await reportProgressTool.handler({ message: 'pending message content' }, mockContext);
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();

    // Now confirm
    const result = await confirmSendToUserTool.handler({}, mockContext);

    expect(result).toBe('Successfully sent the message to the user.');
    expect(mockSendMessageToSlack).toHaveBeenCalledWith('pending message content');
  });

  test('returns error when no pending message', async () => {
    const result = await confirmSendToUserTool.handler({}, mockContext);

    expect(result).toBe('No pending message to confirm. Use sendMessageToUser first.');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });

  test('pending message is cleaned up after confirm', async () => {
    // Block a message (Case 2: has user messages but non-user trigger)
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [{ messageType: 'userMessage' }, { messageType: 'agentMessage', senderAgentName: 'PM' }],
    });

    await reportProgressTool.handler({ message: 'once only' }, mockContext);
    await confirmSendToUserTool.handler({}, mockContext);

    // Second confirm should have no pending message
    const result = await confirmSendToUserTool.handler({}, mockContext);
    expect(result).toBe('No pending message to confirm. Use sendMessageToUser first.');
  });

  test('confirmSendToUser fails when message was blocked by Case 1 (no user messages)', async () => {
    // Case 1: no user messages - message is NOT saved as pending
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [{ messageType: 'agentMessage', senderAgentName: 'PM' }],
    });

    await reportProgressTool.handler({ message: 'should not be saved' }, mockContext);

    // confirmSendToUser should have no pending message
    const result = await confirmSendToUserTool.handler({}, mockContext);
    expect(result).toBe('No pending message to confirm. Use sendMessageToUser first.');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });
});

describe('sendMessageToUser placeholder / scaffolding filter (delivery-path safety)', () => {
  // Same detector as the orchestrator's end-of-turn suppression, applied on
  // the tool-invocation path so a `.` / `<続き…>` / empty message cannot be
  // delivered regardless of which channel the LLM chose. The regression
  // reopens the moment the two paths drift, so these tests are intentionally
  // exhaustive against the real observed patterns.

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PLACEHOLDER_REJECTION_MESSAGE =
    "Your message was detected as a placeholder (empty / '.' / scaffolding artifact) and was NOT delivered to the user. " +
    'Please call sendMessageToUser again with meaningful content, OR end your turn silently if you have nothing new to report.';

  const shouldReject = async (message: string) => {
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    const result = await reportProgressTool.handler({ message }, mockContext);
    expect(result).toBe(PLACEHOLDER_REJECTION_MESSAGE);
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
    expect(mockUpdateSessionLastMessage).not.toHaveBeenCalled();
    expect(mockSendWebappEvent).not.toHaveBeenCalled();
    expect(mockSendPushNotificationToUser).not.toHaveBeenCalled();
  };

  const shouldDeliver = async (message: string, expectedDelivered = message) => {
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    const result = await reportProgressTool.handler({ message }, mockContext);
    expect(result).toBe('Successfully sent a message.');
    expect(mockSendMessageToSlack).toHaveBeenCalledWith(expectedDelivered);
  };

  test('rejects "." and multi-dot placeholders', async () => {
    await shouldReject('.');
    vi.clearAllMocks();
    await shouldReject('..');
    vi.clearAllMocks();
    await shouldReject('...');
  });

  test('rejects invisible-unicode-wrapped "." (ZWSP / ZWNJ / ZWJ / WJ / BOM)', async () => {
    await shouldReject('\u200b.');
    vi.clearAllMocks();
    await shouldReject('.\u200b');
    vi.clearAllMocks();
    await shouldReject('\u200c.');
    vi.clearAllMocks();
    await shouldReject('\u200d.');
    vi.clearAllMocks();
    await shouldReject(' \u2060 . ');
    vi.clearAllMocks();
    await shouldReject('\ufeff.');
  });

  test('rejects whitespace-only and single punctuation', async () => {
    await shouldReject('   ');
    vi.clearAllMocks();
    await shouldReject('\n\t');
    vi.clearAllMocks();
    await shouldReject(',');
    vi.clearAllMocks();
    await shouldReject('_');
  });

  test('rejects whole-message scaffolding artifact', async () => {
    await shouldReject('<続きは以下のツール呼び出しで>');
    vi.clearAllMocks();
    await shouldReject('<continue with more info>');
    vi.clearAllMocks();
    await shouldReject('  <proceeding to next step>  ');
  });

  test('rejects scaffolding prefix with only a placeholder body', async () => {
    // `<続き> .` → prefix-strip → "." → placeholder → reject
    await shouldReject('<続きは以下のツール呼び出しで> .');
    vi.clearAllMocks();
    await shouldReject('<continue> ');
  });

  test('delivers the stripped body when scaffolding prefix wraps a real message', async () => {
    // CJK-behavior validation input: a real CJK body ("reporting progress now")
    // after the CJK scaffolding prefix must survive the strip and be delivered.
    await shouldDeliver('<続きは以下のツール呼び出しで>進捗を報告します', '進捗を報告します');
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    await shouldDeliver('<continue with more info>some message', 'some message');
  });

  test('delivers legitimate short replies unchanged (narrow filter)', async () => {
    await shouldDeliver('ok');
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    await shouldDeliver('done.');
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    await shouldDeliver('4');
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    await shouldDeliver('Completed.');
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    await shouldDeliver('Summary: pushed to branch foo');
  });

  test('delivers legitimate markup unchanged (keyword-gated strip skipped)', async () => {
    await shouldDeliver('<html><body>hello</body></html>');
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    await shouldDeliver('<div> tag is useful');
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    await shouldDeliver('Use <strong> for emphasis');
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
    await shouldDeliver('<?xml version="1.0"?> metadata');
  });
});

describe('sendMessageToUser duplicate suppression (auto-retrigger re-emit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Parent session (top-level) so the child-confirmation branch is skipped.
    mockGetSession.mockResolvedValue({ parentSessionId: undefined });
  });

  test('delivers + records when NOT a near-duplicate', async () => {
    mockShouldSuppressUserDelivery.mockResolvedValue(false);

    const result = await reportProgressTool.handler({ message: 'a fresh status update' }, mockContext);

    expect(result).toBe('Successfully sent a message.');
    expect(mockSendMessageToSlack).toHaveBeenCalledWith('a fresh status update');
    expect(mockRecordUserDelivery).toHaveBeenCalledWith('test-worker-123', 'a fresh status update');
  });

  test('suppresses Slack / push / record when a near-duplicate', async () => {
    mockShouldSuppressUserDelivery.mockResolvedValue(true);

    const result = await reportProgressTool.handler({ message: 'duplicate status update' }, mockContext);

    // The tool still returns success so the LLM is not confused into retrying.
    expect(result).toBe('Successfully sent a message.');
    // ...but NOTHING was delivered to the user, and no delivery was recorded.
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
    expect(mockRecordUserDelivery).not.toHaveBeenCalled();
    expect(mockUpdateSessionLastMessage).not.toHaveBeenCalled();
    expect(mockIncrementUnread).not.toHaveBeenCalled();
    expect(mockSendPushNotificationToUser).not.toHaveBeenCalled();
  });
});
