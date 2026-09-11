import { describe, it, expect } from 'vitest';
import { buildKiroPromptBlocks } from './kiro-loop-helpers';

describe('environmentBlock injection into Kiro prompt', () => {
  const baseSystem = 'You are a helpful assistant.';
  const envBlock = 'Context usage: 42% of max input tokens consumed.';
  const currentTurnItem = {
    PK: 'message-w1' as const,
    SK: '001',
    role: 'user',
    content: JSON.stringify([{ text: 'hello' }]),
    tokenCount: 0,
    messageType: 'user',
  };

  it('environmentBlock appears in prompt when provided', async () => {
    const combinedSystem = `${baseSystem}\n\n${envBlock}`;
    const blocks = await buildKiroPromptBlocks({ systemPrompt: combinedSystem, currentTurnItem });
    const systemBlock = blocks.find(
      (b) => typeof b === 'object' && 'text' in b && b.text.includes('<|SYSTEM_PROMPT|>')
    );
    expect(systemBlock).toBeDefined();
    const text = (systemBlock as { text: string }).text;
    expect(text).toContain(envBlock);
    expect(text).toContain(baseSystem);
  });

  it('prompt works without environmentBlock (no regression)', async () => {
    const blocks = await buildKiroPromptBlocks({ systemPrompt: baseSystem, currentTurnItem });
    const systemBlock = blocks.find(
      (b) => typeof b === 'object' && 'text' in b && b.text.includes('<|SYSTEM_PROMPT|>')
    );
    expect(systemBlock).toBeDefined();
    const text = (systemBlock as { text: string }).text;
    expect(text).toContain(baseSystem);
    expect(text).not.toContain('Context usage');
  });
});

// ---------------------------------------------------------------------------
// Same-turn image recovery + fast-fail (ported from the Bedrock loop).
// These drive the REAL extracted orchestration functions (runImageDimensionRecovery
// / buildRetryFailureResult) with injected true externals; the injected spies
// only record calls (they do NOT re-implement the ordering / decision logic
// under test — that logic lives in the production functions).
// ---------------------------------------------------------------------------
import { vi } from 'vitest';
import { runImageDimensionRecovery, buildRetryFailureResult, type RetryFailureDeps } from './kiro-loop-helpers';

describe('runImageDimensionRecovery (⑤ orchestration: dispose→invalidate→resynth→retry)', () => {
  it('dispose-before-invalidate order is enforced (SIGTERM-flush race)', async () => {
    const order: string[] = [];
    const outcome = await runImageDimensionRecovery<string>({
      effectiveSessionId: 'sess-1',
      cwd: '/tmp/ws',
      dispose: async () => {
        order.push('dispose');
      },
      invalidate: () => {
        order.push('invalidate');
      },
      resynth: async () => {
        order.push('resynth');
      },
      startFreshAgent: async () => {
        order.push('start');
      },
      runPrompt: async () => {
        order.push('prompt');
        return 'ok';
      },
    });
    expect(order).toEqual(['dispose', 'invalidate', 'resynth', 'start', 'prompt']);
    expect(outcome).toEqual({ kind: 'success', result: 'ok' });
  });

  it('same-turn recovery success: retry after invalidate+resynth resolves the turn', async () => {
    const invalidate = vi.fn();
    const resynth = vi.fn(async () => {});
    const outcome = await runImageDimensionRecovery<{ text: string }>({
      effectiveSessionId: 'sess-keep',
      cwd: '/tmp/ws',
      dispose: async () => {},
      invalidate,
      resynth,
      startFreshAgent: async () => {},
      runPrompt: async () => ({ text: 'recovered' }),
    });
    // invalidate + resynth both target the SAME (preserved) sessionId.
    expect(invalidate).toHaveBeenCalledWith('sess-keep', '/tmp/ws');
    expect(resynth).toHaveBeenCalledWith('sess-keep', '/tmp/ws');
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') expect(outcome.result).toEqual({ text: 'recovered' });
  });

  it('retry failure is surfaced as retry-failed (caller maps to fast-fail/retrigger)', async () => {
    const outcome = await runImageDimensionRecovery<string>({
      effectiveSessionId: 'sess-1',
      cwd: '/tmp/ws',
      dispose: async () => {},
      invalidate: () => {},
      resynth: async () => {},
      startFreshAgent: async () => {},
      runPrompt: async () => {
        throw new Error('Image dimensions exceed maximum (again)');
      },
    });
    expect(outcome.kind).toBe('retry-failed');
  });

  it('resynth failure is non-fatal — retry still proceeds', async () => {
    const outcome = await runImageDimensionRecovery<string>({
      effectiveSessionId: 'sess-1',
      cwd: '/tmp/ws',
      dispose: async () => {},
      invalidate: () => {},
      resynth: async () => {
        throw new Error('synthesis blew up');
      },
      startFreshAgent: async () => {},
      runPrompt: async () => 'ok-despite-resynth-fail',
    });
    expect(outcome).toEqual({ kind: 'success', result: 'ok-despite-resynth-fail' });
  });
});

describe('buildRetryFailureResult (fast-fail regression + giveup-bubble)', () => {
  const makeDeps = (over: Partial<RetryFailureDeps> = {}): RetryFailureDeps => ({
    workerId: 'w1',
    unsub: vi.fn(),
    persistErrorBubble: vi.fn(async () => 'sk-bubble'),
    saveConversationHistory: vi.fn(async () => ({})),
    getRetriggerBurstStats: vi.fn(async () => ({ count: 0, elapsedMs: 0 })),
    computeRetriggerBackoffMs: vi.fn(() => 30_000),
    ...over,
  });

  it('fast-fail regression: retry re-fails with image dimension error → abnormalTermination + NO retrigger burst', async () => {
    const getRetriggerBurstStats = vi.fn(async () => ({ count: 0, elapsedMs: 0 }));
    const persistErrorBubble = vi.fn(async () => 'sk-ff');
    const deps = makeDeps({ getRetriggerBurstStats, persistErrorBubble });

    const result = await buildRetryFailureResult(deps, 'ImageValidationError: still too big', 'orig');

    // The 30-min-loop guard: the burst machinery must NOT be consulted.
    expect(getRetriggerBurstStats).not.toHaveBeenCalled();
    expect(result.retrigger).toBeUndefined();
    expect(result.abnormalTermination).toBeDefined();
    // fast-fail is a permanent surface → error bubble persisted + SK on result.
    expect(persistErrorBubble).toHaveBeenCalledTimes(1);
    expect(result.messageSK).toBe('sk-ff');
  });

  it('non-image retry failure within budget → transparent auto-retrigger (no bubble)', async () => {
    const persistErrorBubble = vi.fn(async () => 'sk');
    const deps = makeDeps({
      persistErrorBubble,
      getRetriggerBurstStats: vi.fn(async () => ({ count: 1, elapsedMs: 60_000 })),
      computeRetriggerBackoffMs: vi.fn(() => 45_000),
    });

    const result = await buildRetryFailureResult(deps, 'JSON-RPC -32603 transient', 'orig');

    expect(result.retrigger).toBe(true);
    expect(result.retriggerDelayMs).toBe(45_000);
    // Transparent recovery delivers nothing to the UX — no bubble.
    expect(persistErrorBubble).not.toHaveBeenCalled();
  });

  it('giveup-bubble ride-along: budget exhausted → persist bubble + messageSK on result (kiro giveup path)', async () => {
    const persistErrorBubble = vi.fn(async () => 'sk-giveup');
    const deps = makeDeps({
      persistErrorBubble,
      getRetriggerBurstStats: vi.fn(async () => ({ count: 9, elapsedMs: 40 * 60_000 })),
      computeRetriggerBackoffMs: vi.fn(() => null), // budget exhausted
    });

    const result = await buildRetryFailureResult(deps, 'JSON-RPC -32603 transient', 'orig');

    expect(persistErrorBubble).toHaveBeenCalledTimes(1);
    expect(result.messageSK).toBe('sk-giveup');
    expect(result.abnormalTermination).toBeDefined();
    expect(result.retrigger).toBeUndefined();
  });
});
