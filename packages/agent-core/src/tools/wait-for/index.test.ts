import { describe, expect, test } from 'vitest';
import {
  waitForCondition,
  interruptibleSleep,
  waitForConditionTool,
  MAX_WAIT_CEILING_SECONDS,
  type WaitForConditionDeps,
} from './index';
import { BACKGROUND_CANCELLATION_MARKER } from '../command-execution';

/**
 * Build a deterministic test harness: a fake clock advanced by the injected
 * sleep, and a scripted runCommand. No real timers or child processes.
 */
const makeHarness = (
  responses: Array<{ stdout?: string; stderr?: string; error?: string; exitCode?: number }>,
  opts: { perCallMs?: number; onCall?: (i: number) => void } = {}
) => {
  const perCallMs = opts.perCallMs ?? 0;
  let clock = 0;
  let call = 0;
  const calls: string[] = [];
  const deps: Required<Pick<WaitForConditionDeps, 'runCommand' | 'sleep' | 'now'>> = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    runCommand: async (command: string) => {
      calls.push(command);
      if (opts.onCall) opts.onCall(call);
      clock += perCallMs;
      const idx = Math.min(call, responses.length - 1);
      call++;
      return {
        stdout: responses[idx]?.stdout ?? '',
        stderr: responses[idx]?.stderr ?? '',
        error: responses[idx]?.error,
        exitCode: responses[idx]?.exitCode,
      };
    },
  };
  return { deps, getCalls: () => calls };
};

describe('waitForCondition', () => {
  test('succeeds on exit0 after polling a few times', async () => {
    // First two checks "not ready" (nonzero exit), third exits 0.
    const { deps, getCalls } = makeHarness([
      { error: 'Command failed with exit code 1', exitCode: 1 },
      { error: 'Command failed with exit code 1', exitCode: 1 },
      { stdout: 'done' },
    ]);

    const result = await waitForCondition(
      { checkCommand: 'check.sh', successWhen: 'exit0', maxWaitSeconds: 600 },
      undefined,
      deps
    );

    expect(result.outcome).toBe('succeeded');
    expect(result.checks).toBe(3);
    expect(getCalls()).toHaveLength(3);
  });

  test('succeeds when successWhen regex matches output', async () => {
    const { deps } = makeHarness([{ stdout: 'status: InProgress' }, { stdout: 'status: Completed' }]);

    const result = await waitForCondition(
      { checkCommand: 'status.sh', successWhen: 'Completed', maxWaitSeconds: 600 },
      undefined,
      deps
    );

    expect(result.outcome).toBe('succeeded');
    expect(result.checks).toBe(2);
  });

  test('fails fast when failWhen regex matches', async () => {
    const { deps } = makeHarness([{ stdout: 'status: Failed' }]);

    const result = await waitForCondition(
      { checkCommand: 'status.sh', successWhen: 'Completed', failWhen: 'Failed', maxWaitSeconds: 600 },
      undefined,
      deps
    );

    expect(result.outcome).toBe('failed');
    expect(result.checks).toBe(1);
  });

  test('times out when condition is never met', async () => {
    // Always "not ready". Each check costs 30s, backoff sleeps advance clock too.
    const { deps } = makeHarness([{ error: 'Command failed with exit code 1', exitCode: 1 }], { perCallMs: 30_000 });

    const result = await waitForCondition(
      {
        checkCommand: 'never.sh',
        successWhen: 'exit0',
        maxWaitSeconds: 120,
        initialIntervalMs: 5000,
        maxIntervalMs: 30000,
      },
      undefined,
      deps
    );

    expect(result.outcome).toBe('timeout');
    expect(result.message).toContain('createEventTrigger');
  });

  test('interrupted when cancellation token flips mid-wait', async () => {
    const token = { isCancelled: false };
    // Flip the token on the 2nd check so the post-check guard catches it.
    const { deps } = makeHarness([{ error: 'Command failed with exit code 1', exitCode: 1 }], {
      onCall: (i) => {
        if (i >= 1) token.isCancelled = true;
      },
    });

    const result = await waitForCondition(
      { checkCommand: 'check.sh', successWhen: 'exit0', maxWaitSeconds: 600 },
      token,
      deps
    );

    expect(result.outcome).toBe('interrupted');
  });

  test('interrupted when executeCommand reports background (cancelled) command', async () => {
    const { deps } = makeHarness([
      {
        error: `Command ${BACKGROUND_CANCELLATION_MARKER} (PID: 123). The agent session was interrupted by a new incoming message.`,
      },
    ]);

    const result = await waitForCondition(
      { checkCommand: 'check.sh', successWhen: 'exit0', maxWaitSeconds: 600 },
      { isCancelled: false },
      deps
    );

    expect(result.outcome).toBe('interrupted');
  });

  test('caps maxWaitSeconds at the ceiling and notes the handoff guidance', async () => {
    const { deps } = makeHarness([{ error: 'nonzero', exitCode: 1 }], { perCallMs: 60_000 });

    const result = await waitForCondition(
      { checkCommand: 'never.sh', successWhen: 'exit0', maxWaitSeconds: MAX_WAIT_CEILING_SECONDS + 100_000 },
      undefined,
      deps
    );

    expect(result.outcome).toBe('timeout');
    expect(result.message).toContain('capped');
    expect(result.message).toContain(`${MAX_WAIT_CEILING_SECONDS}s`);
  });

  test('rejects an invalid successWhen regex', async () => {
    const { deps } = makeHarness([{ stdout: 'x' }]);
    await expect(waitForCondition({ checkCommand: 'c.sh', successWhen: '(' }, undefined, deps)).rejects.toThrow(
      /Invalid successWhen regex/
    );
  });

  test('rejects an empty successWhen regex (would match everything)', async () => {
    const { deps } = makeHarness([{ stdout: 'x' }]);
    await expect(waitForCondition({ checkCommand: 'c.sh', successWhen: '' }, undefined, deps)).rejects.toThrow(
      /empty pattern/
    );
  });

  test('rejects an invalid failWhen regex', async () => {
    const { deps } = makeHarness([{ stdout: 'x' }]);
    await expect(
      waitForCondition({ checkCommand: 'c.sh', successWhen: 'ok', failWhen: '(' }, undefined, deps)
    ).rejects.toThrow(/Invalid failWhen regex/);
  });

  test('failWhen takes precedence when both patterns match the same output', async () => {
    const { deps } = makeHarness([{ stdout: 'done but Failed' }]);
    const result = await waitForCondition(
      { checkCommand: 's.sh', successWhen: 'done', failWhen: 'Failed', maxWaitSeconds: 600 },
      undefined,
      deps
    );
    expect(result.outcome).toBe('failed');
  });
});

describe('waitForConditionTool schema validation', () => {
  const parse = (overrides: Record<string, unknown>) =>
    waitForConditionTool.schema.safeParse({ checkCommand: 'c.sh', successWhen: 'exit0', ...overrides });

  test('accepts a minimal valid input', () => {
    expect(parse({}).success).toBe(true);
  });

  test('rejects empty successWhen', () => {
    expect(parse({ successWhen: '' }).success).toBe(false);
  });

  test('rejects non-positive / non-integer intervals', () => {
    expect(parse({ initialIntervalMs: 0 }).success).toBe(false);
    expect(parse({ initialIntervalMs: -5 }).success).toBe(false);
    expect(parse({ maxIntervalMs: 1.5 }).success).toBe(false);
  });

  test('rejects backoffMultiplier < 1', () => {
    expect(parse({ backoffMultiplier: 0.5 }).success).toBe(false);
    expect(parse({ backoffMultiplier: 1 }).success).toBe(true);
  });

  test('rejects maxWaitSeconds below 1 or non-integer', () => {
    expect(parse({ maxWaitSeconds: 0 }).success).toBe(false);
    expect(parse({ maxWaitSeconds: 1.5 }).success).toBe(false);
    expect(parse({ maxWaitSeconds: 1 }).success).toBe(true);
  });
});

describe('interruptibleSleep', () => {
  test('resolves early when the token is cancelled', async () => {
    const token = { isCancelled: false };
    const start = Date.now();
    const p = interruptibleSleep(5000, token);
    setTimeout(() => {
      token.isCancelled = true;
    }, 150);
    await p;
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('resolves after the full duration without a token', async () => {
    const start = Date.now();
    await interruptibleSleep(120);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });
});
