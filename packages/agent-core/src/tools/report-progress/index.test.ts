import { describe, expect, test, vi, beforeEach } from 'vitest';
import { globalPreferencesSchema } from '../../schema';

const mockGetSession = vi.fn();
const mockGetConversationHistory = vi.fn();
const mockSendMessageToSlack = vi.fn();
const mockUpdateSessionLastMessage = vi.fn();
const mockSendWebappEvent = vi.fn();
const mockSendPushNotificationToUser = vi.fn();
const mockIncrementUnread = vi.fn();

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
}));

vi.mock('../../lib/unread', () => ({
  incrementUnread: (...args: any[]) => mockIncrementUnread(...args),
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

  test('child session with triggering message as agentMessage returns confirmation prompt', async () => {
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

    expect(result).toContain('This is a child session');
    expect(result).toContain('Messages from user in this session: 1');
    expect(result).toContain('agentMessage (PM Agent)');
    expect(result).toContain('confirmSendToUser');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });

  test('child session with triggering message as eventTrigger returns confirmation prompt', async () => {
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [
        { messageType: 'eventTrigger' },
        { messageType: 'assistant' },
        { messageType: 'toolUse' },
      ],
    });

    const result = await reportProgressTool.handler({ message: 'event response' }, mockContext);

    expect(result).toContain('This is a child session');
    expect(result).toContain('Messages from user in this session: 0');
    expect(result).toContain('eventTrigger');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });

  test('skips toolUse/toolResult/assistant/errorFeedback to find triggering message', async () => {
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

    expect(result).toContain('This is a child session');
    expect(result).toContain('agentMessage (Parent)');
    expect(mockSendMessageToSlack).not.toHaveBeenCalled();
  });

  test('child session with empty items returns confirmation prompt', async () => {
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [],
    });

    const result = await reportProgressTool.handler({ message: 'empty history' }, mockContext);

    expect(result).toContain('This is a child session');
    expect(result).toContain('Messages from user in this session: 0');
    expect(result).toContain('unknown');
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
    // First block a message
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [{ messageType: 'agentMessage', senderAgentName: 'PM' }],
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
    // Block a message
    mockGetSession.mockResolvedValue({ parentSessionId: 'parent-123' });
    mockGetConversationHistory.mockResolvedValue({
      items: [{ messageType: 'agentMessage', senderAgentName: 'PM' }],
    });

    await reportProgressTool.handler({ message: 'once only' }, mockContext);
    await confirmSendToUserTool.handler({}, mockContext);

    // Second confirm should have no pending message
    const result = await confirmSendToUserTool.handler({}, mockContext);
    expect(result).toBe('No pending message to confirm. Use sendMessageToUser first.');
  });
});
