/**
 * c5: env-tunable session-setup timeouts (initialize / session/new /
 * session/load). Exercises the REAL production helpers (withTimeout + the env
 * getters) used by KiroAcpAgent.ensureStarted().
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  withTimeout,
  kiroInitializeTimeoutMs,
  kiroSessionNewTimeoutMs,
  kiroSessionLoadTimeoutMs,
  awaitSessionOpen,
  computeOuterCeilingMs,
} from './kiro-acp-agent';
import { classifyKiroFailure } from '../kiro-loop-helpers';

describe('c5 withTimeout', () => {
  it('resolves with the value when the promise settles first', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'session/new')).resolves.toBe('ok');
  });

  it('rejects with a labelled, greppable, kiro-marked message when the deadline hits first', async () => {
    const never = new Promise<string>(() => {});
    // The message must carry the `kiro-cli` marker (so the UX-sanitiser
    // collapses it) AND keep the `timed out` substring (so it stays retryable).
    await expect(withTimeout(never, 5, 'session/load')).rejects.toThrow(
      /Kiro ACP session\/load \(kiro-cli\) timed out after/
    );
  });

  it('timeoutMs <= 0 disables the bound (never rejects on time)', async () => {
    await expect(withTimeout(Promise.resolve('x'), 0, 'initialize')).resolves.toBe('x');
    await expect(withTimeout(Promise.resolve('y'), -1, 'initialize')).resolves.toBe('y');
  });

  it('propagates the underlying rejection unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'session/new')).rejects.toThrow('boom');
  });

  it('its timeout error is classified as a retryable idle-timeout (not permanent)', () => {
    expect(classifyKiroFailure('Kiro ACP session/load timed out after 120s')).toBe('idle-timeout');
    expect(classifyKiroFailure('Kiro ACP initialize timed out after 120s')).toBe('idle-timeout');
  });
});

describe('c5 setup-timeout tunables', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults: initialize 120000, session/new 30000, session/load 120000', () => {
    expect(kiroInitializeTimeoutMs()).toBe(120_000);
    expect(kiroSessionNewTimeoutMs()).toBe(30_000);
    expect(kiroSessionLoadTimeoutMs()).toBe(120_000);
  });

  it('env overrides are honored', () => {
    vi.stubEnv('KIRO_ACP_INITIALIZE_TIMEOUT_MS', '90000');
    vi.stubEnv('KIRO_ACP_SESSION_NEW_TIMEOUT_MS', '45000');
    vi.stubEnv('KIRO_ACP_SESSION_LOAD_TIMEOUT_MS', '200000');
    expect(kiroInitializeTimeoutMs()).toBe(90_000);
    expect(kiroSessionNewTimeoutMs()).toBe(45_000);
    expect(kiroSessionLoadTimeoutMs()).toBe(200_000);
  });

  it('invalid values fall back to defaults', () => {
    vi.stubEnv('KIRO_ACP_SESSION_LOAD_TIMEOUT_MS', 'nope');
    expect(kiroSessionLoadTimeoutMs()).toBe(120_000);
  });
});

describe('computeOuterCeilingMs', () => {
  it('is strictly larger than any inner bound so it never pre-empts an inner phase', () => {
    // initialize 120s, load 120s, new 30s → outer must exceed 120s (the max
    // inner), otherwise a load timeout would be mislabeled as initialize.
    const outer = computeOuterCeilingMs({ initializeMs: 120_000, sessionLoadMs: 120_000, sessionNewMs: 30_000 });
    expect(outer).toBeGreaterThan(120_000);
    expect(outer).toBe(240_000);
  });

  it('returns 0 (disabled) only when the initialize bound is 0', () => {
    expect(computeOuterCeilingMs({ initializeMs: 0, sessionLoadMs: 120_000, sessionNewMs: 30_000 })).toBe(0);
    expect(computeOuterCeilingMs({ initializeMs: 60_000, sessionLoadMs: 0, sessionNewMs: 0 })).toBe(60_000);
  });
});

describe('awaitSessionOpen (start()-path surfacing)', () => {
  it('a connect-phase rejection on connectionDone surfaces immediately with its real label', async () => {
    // `opened` never settles (it only resolves on success from inside
    // connectWith); connectionDone rejects with the real inner error. The race
    // must reject with THAT error, not hang until the outer bound.
    const opened = new Promise<void>(() => {}); // never resolves
    const connectionDone = Promise.reject(new Error('Kiro ACP session/load timed out after 120s'));
    await expect(
      awaitSessionOpen(opened, connectionDone, { initializeMs: 120_000, sessionLoadMs: 120_000, sessionNewMs: 30_000 })
    ).rejects.toThrow(/session\/load timed out/);
  });

  it('resolves when opened resolves (clean success)', async () => {
    const opened = Promise.resolve();
    const connectionDone = new Promise<void>(() => {}); // stays pending (only settles on teardown)
    await expect(
      awaitSessionOpen(opened, connectionDone, { initializeMs: 120_000, sessionLoadMs: 120_000, sessionNewMs: 30_000 })
    ).resolves.toBeUndefined();
  });

  it("session/load timeout is NOT dead code — it wins over the (larger) outer 'initialize' ceiling", async () => {
    // Simulate the real wiring: connectionDone carries the inner session/load
    // rejection produced by the inner withTimeout. Because the outer ceiling is
    // initialize+maxInner (> load), the inner load error is what surfaces.
    const opened = new Promise<void>(() => {});
    const loadError = new Error('Kiro ACP session/load timed out after 120s');
    const connectionDone = Promise.reject(loadError);
    const err = await awaitSessionOpen(opened, connectionDone, {
      initializeMs: 120_000,
      sessionLoadMs: 120_000,
      sessionNewMs: 30_000,
    }).catch((e) => e);
    expect((err as Error).message).toContain('session/load');
    expect((err as Error).message).not.toContain('initialize');
  });

  it('outer ceiling fires (labelled initialize) when neither opened nor connectionDone settle', async () => {
    const opened = new Promise<void>(() => {});
    const connectionDone = new Promise<void>(() => {});
    // Tiny outer bound via initializeMs; inner bounds 0 so outer == initializeMs.
    await expect(
      awaitSessionOpen(opened, connectionDone, { initializeMs: 5, sessionLoadMs: 0, sessionNewMs: 0 })
    ).rejects.toThrow(/initialize \(kiro-cli\) timed out/);
  });
});
