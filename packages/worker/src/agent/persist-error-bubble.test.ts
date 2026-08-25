import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSaveConversationHistory = vi.fn();

vi.mock('@remote-swe-agents/agent-core/lib', () => ({
  saveConversationHistory: (...args: unknown[]) => mockSaveConversationHistory(...args),
}));

const { persistErrorBubble } = await import('./persist-error-bubble');

describe('persistErrorBubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveConversationHistory.mockResolvedValue({ SK: '00001787130000000' });
  });

  test('persists with messageType assistant and returns SK', async () => {
    const sk = await persistErrorBubble('w1', 'An error occurred: boom');
    expect(mockSaveConversationHistory).toHaveBeenCalledWith(
      'w1',
      { role: 'assistant', content: [{ text: 'An error occurred: boom' }] },
      0,
      'assistant'
    );
    expect(sk).toBe('00001787130000000');
  });

  test('returns undefined on DDB failure (best-effort, does not throw)', async () => {
    mockSaveConversationHistory.mockRejectedValue(new Error('DDB down'));
    const sk = await persistErrorBubble('w1', 'An error occurred: boom');
    expect(sk).toBeUndefined();
  });

  test('messageType is always assistant (never internalError — B3 regression guard)', async () => {
    await persistErrorBubble('w1', 'test');
    const messageType = mockSaveConversationHistory.mock.calls[0]![3];
    expect(messageType).toBe('assistant');
    expect(messageType).not.toBe('internalError');
  });
});
