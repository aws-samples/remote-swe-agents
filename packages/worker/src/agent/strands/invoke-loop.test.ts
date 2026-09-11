/**
 * Tests for the extracted invoke loop (rewrite).
 * These exercise production code paths — not local reimplementations.
 * Specifically verifies:
 *  1. Recoverable error → 2nd invoke called with non-empty MessageData[]
 *  2. Permanent error → no retry + willRetry:false emit
 *  3. Circuit breaker trips after 3 consecutive, resets on model call success
 *  4. External reset between retries (BeforeToolsEvent parity) → count restarts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runInvokeLoop, type InvokeLoopDeps, type InvokeLoopState } from './invoke-loop';

function makeDeps(overrides: Partial<InvokeLoopDeps> = {}): InvokeLoopDeps {
  return {
    invoke: vi.fn().mockResolvedValue({ stopReason: 'end_turn', lastMessage: {} }),
    saveConversationHistory: vi.fn().mockResolvedValue(undefined),
    sendWebappEvent: vi.fn().mockResolvedValue(undefined),
    sendSystemMessage: vi.fn().mockResolvedValue(undefined),
    persistErrorBubble: vi.fn().mockResolvedValue('sk-error-bubble'),
    isCancelled: () => false,
    workerId: 'test-worker',
    slackUserId: undefined,
    ...overrides,
  };
}

function freshState(): InvokeLoopState {
  return { consecutiveErrorCount: 0, lastErrorType: '' };
}

describe('runInvokeLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recoverable error → 2nd invoke called with non-empty MessageData[] content', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('ModelErrorException: Internal failure'))
      .mockResolvedValueOnce({ stopReason: 'end_turn' });

    const deps = makeDeps({ invoke });
    const state = freshState();
    const result = await runInvokeLoop(deps, 'initial-arg', state);

    // Should have been called twice
    expect(invoke).toHaveBeenCalledTimes(2);

    // 2nd call's argument must be a MessageData[] with non-empty text content
    const retryArg = invoke.mock.calls[1]![0] as Array<{ role: string; content: Array<{ text: string }> }>;
    expect(retryArg).toHaveLength(1);
    expect(retryArg[0]!.role).toBe('user');
    expect(retryArg[0]!.content).toHaveLength(1);
    expect(retryArg[0]!.content[0]!.text).toContain('[SYSTEM ERROR FEEDBACK]');
    expect(retryArg[0]!.content[0]!.text).toContain('model_error');
    expect(retryArg[0]!.content[0]!.text.length).toBeGreaterThan(0);

    // Success on 2nd try
    expect(result).toEqual({ stopReason: 'end_turn' });

    // State reset on success
    expect(state.consecutiveErrorCount).toBe(0);
    expect(state.lastErrorType).toBe('');

    // willRetry:true event emitted for the first error
    expect(deps.sendWebappEvent).toHaveBeenCalledWith(
      'test-worker',
      expect.objectContaining({
        type: 'agentError',
        willRetry: true,
      })
    );
  });

  it('permanent error → no retry + willRetry:false emit', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('ValidationException: Invalid input provided'));

    const deps = makeDeps({ invoke });
    const state = freshState();
    const result = await runInvokeLoop(deps, 'initial-arg', state);

    // Only 1 call — no retry for permanent errors
    expect(invoke).toHaveBeenCalledTimes(1);

    // Result is null (signal to caller that turn should abort)
    expect(result).toBeNull();

    // willRetry:false event emitted
    expect(deps.sendWebappEvent).toHaveBeenCalledWith(
      'test-worker',
      expect.objectContaining({
        type: 'agentError',
        errorType: 'validation_error',
        willRetry: false,
      })
    );

    // System message sent to user
    expect(deps.sendSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('permanent error → persists error bubble BEFORE notify + passes messageSK to sendSystemMessage', async () => {
    // regression guard (e44b8507 parity): the notification must be
    // persisted as an 'assistant' bubble (so it survives reload) and the
    // resulting SK must be threaded into sendSystemMessage — and the persist
    // must happen BEFORE the notify. Records real invocation order via true
    // external mocks (no logic re-implementation).
    const callOrder: string[] = [];
    const persistErrorBubble = vi.fn(async (_workerId: string, _errorText: string): Promise<string | undefined> => {
      callOrder.push('persist');
      return 'sk-perm-42';
    });
    const sendSystemMessage = vi.fn(
      async (
        _workerId: string,
        _msg: string,
        _appendWebappUrl: boolean,
        _skipWebappEmit?: boolean,
        _messageSK?: string
      ): Promise<void> => {
        callOrder.push('notify');
      }
    );
    const invoke = vi.fn().mockRejectedValueOnce(new Error('ValidationException: Invalid input provided'));

    const deps = makeDeps({ invoke, persistErrorBubble, sendSystemMessage });
    const state = freshState();
    await runInvokeLoop(deps, 'initial-arg', state);

    // persist ran, exactly once, BEFORE notify
    expect(persistErrorBubble).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['persist', 'notify']);

    // notify received the SK returned by persist (5th positional arg)
    const notifyCall = sendSystemMessage.mock.calls[0]!;
    expect(notifyCall[4]).toBe('sk-perm-42');

    // persisted text equals the notified text (same bubble, not a divergent copy)
    expect(persistErrorBubble.mock.calls[0]![1]).toBe(notifyCall[1]);
  });

  it('circuit breaker → persists error bubble BEFORE notify + passes messageSK', async () => {
    const callOrder: string[] = [];
    const persistErrorBubble = vi.fn(async (_workerId: string, _errorText: string): Promise<string | undefined> => {
      callOrder.push('persist');
      return 'sk-breaker-7';
    });
    const sendSystemMessage = vi.fn(
      async (
        _workerId: string,
        _msg: string,
        _appendWebappUrl: boolean,
        _skipWebappEmit?: boolean,
        _messageSK?: string
      ): Promise<void> => {
        callOrder.push('notify');
      }
    );
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('ModelErrorException: 1'))
      .mockRejectedValueOnce(new Error('ModelErrorException: 2'))
      .mockRejectedValueOnce(new Error('ModelErrorException: 3'));

    const deps = makeDeps({ invoke, persistErrorBubble, sendSystemMessage });
    const state = freshState();
    await runInvokeLoop(deps, 'initial-arg', state);

    expect(persistErrorBubble).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['persist', 'notify']);
    expect(sendSystemMessage.mock.calls[0]![4]).toBe('sk-breaker-7');
  });

  it('circuit breaker trips after 3 consecutive same-type errors', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('ModelErrorException: 1'))
      .mockRejectedValueOnce(new Error('ModelErrorException: 2'))
      .mockRejectedValueOnce(new Error('ModelErrorException: 3'));

    const deps = makeDeps({ invoke });
    const state = freshState();
    const result = await runInvokeLoop(deps, 'initial-arg', state);

    // 3 calls — breaker trips on 3rd
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result).toBeNull();
    expect(state.consecutiveErrorCount).toBe(3);
  });

  it('external reset between retries → count restarts from 1 (BeforeToolsEvent parity)', async () => {
    // Simulates: invoke fails twice, then an external hook resets state (as
    // BeforeToolsEvent does on a successful model call mid-loop), then another
    // failure should start fresh at count 1 instead of continuing from 3.
    const state = freshState();

    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('ModelErrorException: fail-1'))
      .mockRejectedValueOnce(new Error('ModelErrorException: fail-2'))
      .mockImplementationOnce(async () => {
        // Simulate external hook resetting state between retries
        // (in production: BeforeToolsEvent fires on successful model call)
        state.consecutiveErrorCount = 0;
        state.lastErrorType = '';
        // Then this invoke also fails
        throw new Error('ModelErrorException: fail-after-reset');
      })
      .mockResolvedValueOnce({ stopReason: 'end_turn' });

    const deps = makeDeps({ invoke });
    const result = await runInvokeLoop(deps, 'initial-arg', state);

    // All 4 calls should have been made (no breaker trip because reset happened)
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(result).toEqual({ stopReason: 'end_turn' });
    // Final state: reset on success
    expect(state.consecutiveErrorCount).toBe(0);
    expect(state.lastErrorType).toBe('');
  });
});

import { makeSaveHistoryDep } from '../bedrock-strands-agent-loop';

describe('runInvokeLoop errorFeedback item propagation', () => {
  it('makeSaveHistoryDep pushes saved item to appendedItems on every call', async () => {
    const savedItem = {
      PK: 'message-w1',
      SK: '001',
      role: 'user',
      content: '[]',
      tokenCount: 0,
      messageType: 'errorFeedback',
    };
    const appendedItems: any[] = [];
    const mockPersist = vi.fn().mockResolvedValue(savedItem);

    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('ModelErrorException: transient'))
      .mockResolvedValueOnce({ stopReason: 'end_turn' });

    const deps = makeDeps({
      invoke,
      saveConversationHistory: makeSaveHistoryDep(appendedItems, mockPersist as any),
    });

    const state = freshState();
    await runInvokeLoop(deps, 'initial-arg', state);

    // Real factory was exercised: persist called + item pushed
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(appendedItems).toHaveLength(1);
    expect(appendedItems[0]).toBe(savedItem);
  });
});
