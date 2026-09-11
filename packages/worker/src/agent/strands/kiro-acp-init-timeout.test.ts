/**
 * Init/handshake timeout for the live kiro-cli SDK path.
 *
 * These tests drive the REAL production helpers used by
 * `KiroAcpAgent.ensureStarted()` (`raceWithInitTimeout`, `buildInitTimeoutError`,
 * `resolveInitTimeoutMs`) — no mock re-implements the behaviour under test. The
 * "hang" is a genuinely never-resolving promise (the real failure mode: kiro-cli
 * not completing its `initialize`/`session/*` handshake), and the classification
 * is asserted against the real matchers so the timeout→retry join is verified
 * end-to-end at the wiring level.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { raceWithInitTimeout, buildInitTimeoutError, resolveInitTimeoutMs, withTimeout } from './kiro-acp-agent';
import { isPromptTimeoutOrIdleError, isKnownKiroInternalError } from '../kiro-loop-helpers';

describe('resolveInitTimeoutMs (env-driven, legacy-compatible)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 120_000ms when env unset', () => {
    vi.stubEnv('KIRO_ACP_INITIALIZE_TIMEOUT_MS', '');
    expect(resolveInitTimeoutMs()).toBe(120_000);
  });

  it('reads a valid override from KIRO_ACP_INITIALIZE_TIMEOUT_MS', () => {
    vi.stubEnv('KIRO_ACP_INITIALIZE_TIMEOUT_MS', '5000');
    expect(resolveInitTimeoutMs()).toBe(5000);
  });

  it('0 disables the timeout (explicit opt-out)', () => {
    vi.stubEnv('KIRO_ACP_INITIALIZE_TIMEOUT_MS', '0');
    expect(resolveInitTimeoutMs()).toBe(0);
  });

  it('falls back to default on a non-numeric / negative value', () => {
    vi.stubEnv('KIRO_ACP_INITIALIZE_TIMEOUT_MS', 'nonsense');
    expect(resolveInitTimeoutMs()).toBe(120_000);
    vi.stubEnv('KIRO_ACP_INITIALIZE_TIMEOUT_MS', '-1');
    expect(resolveInitTimeoutMs()).toBe(120_000);
  });
});

describe('buildInitTimeoutError wording is recognised by BOTH classifiers (retry join contract)', () => {
  const err = buildInitTimeoutError(120_000);

  it('is classified as a timeout/idle error → retry-phase start() recovers', () => {
    expect(isPromptTimeoutOrIdleError(err.message)).toBe(true);
  });

  it('is classified as a known kiro internal error → terminal init failure collapses to canonical UX phrase', () => {
    expect(isKnownKiroInternalError(err.message)).toBe(true);
  });

  it('includes the actual timeout value so logs are actionable', () => {
    expect(buildInitTimeoutError(5000).message).toContain('5000ms');
  });
});

describe('raceWithInitTimeout — real race against a hanging handshake', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with the identifiable init-timeout error when the handshake never resolves', async () => {
    vi.useFakeTimers();
    // A genuinely never-resolving promise = the real init-hang failure mode.
    const hangingOpen = new Promise<void>(() => {});
    const raced = raceWithInitTimeout(hangingOpen, 1000);
    // Attach rejection handler before advancing timers to avoid unhandled rejection.
    const assertion = expect(raced).rejects.toThrow(buildInitTimeoutError(1000).message);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('the rejection it throws is retryable per the real timeout matcher (timeout → retry join)', async () => {
    vi.useFakeTimers();
    const hangingOpen = new Promise<void>(() => {});
    const raced = raceWithInitTimeout(hangingOpen, 1000);
    const captured = raced.then(
      () => {
        throw new Error('expected raceWithInitTimeout to reject on timeout');
      },
      (e: unknown) => e as Error
    );
    await vi.advanceTimersByTimeAsync(1000);
    const thrown = await captured;
    // Drive the real matcher used at the loop's retry decision (line ~684).
    expect(isPromptTimeoutOrIdleError(thrown.message)).toBe(true);
  });

  it('resolves with the handshake value when init completes before the timeout (no false positive)', async () => {
    vi.useFakeTimers();
    const openedOk = Promise.resolve<'opened'>('opened');
    const raced = raceWithInitTimeout(openedOk, 1000);
    // No timer advance needed; work wins immediately.
    await expect(raced).resolves.toBe('opened');
  });

  it('timeoutMs <= 0 disables the timer and simply awaits the work', async () => {
    // Real timers: prove no timer is armed (would never fire) and work is awaited.
    const openedOk = Promise.resolve<'ok'>('ok');
    await expect(raceWithInitTimeout(openedOk, 0)).resolves.toBe('ok');
  });
});

/**
 * Regression: the LIVE setup-phase bound is `withTimeout` (labels
 * `initialize` / `session/load` / `session/new`), NOT the retained
 * `raceWithInitTimeout`/`buildInitTimeoutError` (now production-dead). The
 * previous tests only asserted the DEAD helper's wording, so when the merge
 * re-wired the live path onto `withTimeout` — whose message did NOT carry a
 * kiro-specific marker — the raw error leaked to the UX and NO test caught it.
 * These assertions pin the LIVE message wording against BOTH real classifiers.
 */
describe('LIVE withTimeout setup-phase wording is recognised by BOTH classifiers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Produce the ACTUAL live error message by letting withTimeout time out on a
  // never-resolving promise (the real setup-hang failure mode) for each label
  // the live ensureStarted() uses.
  const liveTimeoutMessage = async (label: string): Promise<string> => {
    vi.useFakeTimers();
    const hanging = new Promise<void>(() => {});
    const raced = withTimeout(hanging, 120_000, label);
    const captured = raced.then(
      () => {
        throw new Error('expected withTimeout to reject on timeout');
      },
      (e: unknown) => (e as Error).message
    );
    await vi.advanceTimersByTimeAsync(120_000);
    return captured;
  };

  for (const label of ['initialize', 'session/load', 'session/new']) {
    it(`'${label}' timeout collapses to the canonical UX phrase (isKnownKiroInternalError=true)`, async () => {
      const msg = await liveTimeoutMessage(label);
      // The regression: without a kiro marker this was false → raw leak.
      expect(isKnownKiroInternalError(msg)).toBe(true);
    });

    it(`'${label}' timeout stays retryable on the prompt-phase path (isPromptTimeoutOrIdleError=true)`, async () => {
      const msg = await liveTimeoutMessage(label);
      expect(isPromptTimeoutOrIdleError(msg)).toBe(true);
    });
  }
});
