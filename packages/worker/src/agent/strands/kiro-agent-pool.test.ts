/**
 * Turn-to-turn kiro-cli process reuse pool.
 * Exercises the REAL KiroAgentPool + buildReuseKey against a fake PoolableAgent
 * (only externals — the subprocess — are faked; the pool logic runs for real).
 *
 * The pool API is store / tryAcquire / clear / isCached only — there is no
 * `release()` (the loop's finalizeAgent maps clean→store and cancel/error→clear,
 * so a cancelled turn leaves NO cached entry; that behaviour is covered by the
 * loop×pool integration test, not here).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  KiroAgentPool,
  buildReuseKey,
  kiroProcessReuseEnabled,
  kiroProcessMaxAgeMs,
  type PoolableAgent,
  type ReuseKeyInput,
} from './kiro-agent-pool';

class FakeAgent implements PoolableAgent {
  disposed = false;
  disposeCount = 0;
  constructor(
    public readonly createdAt: number,
    private alive = true
  ) {}
  isAlive(): boolean {
    return this.alive && !this.disposed;
  }
  kill(): void {
    this.alive = false;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.alive = false;
    this.disposeCount++;
  }
}

const baseKeyInput = (over: Partial<ReuseKeyInput> = {}): ReuseKeyInput => ({
  workerId: 'w1',
  sessionId: 'sess-1',
  model: 'claude-sonnet-4.6',
  agentName: 'remote-swe',
  mcpServers: [
    { type: 'stdio', name: 'b', command: 'b-cmd', args: ['--b'] },
    { type: 'stdio', name: 'a', command: 'a-cmd', args: ['--a'] },
  ],
  apiKey: 'api-key-1',
  cwd: '/work/dir',
  rewindState: undefined,
  ...over,
});

describe('buildReuseKey', () => {
  it('changes when the rewind fingerprint changes (rewind apply)', () => {
    const none = buildReuseKey(baseKeyInput({ rewindState: undefined }));
    const rewound = buildReuseKey(baseKeyInput({ rewindState: { cutoffSK: '000000000000123', rewindedAt: 999 } }));
    expect(none).not.toBe(rewound);
  });

  it('changes when rewind is undone (cutoff/rewindedAt differ), and matches identical state', () => {
    const a = buildReuseKey(baseKeyInput({ rewindState: { cutoffSK: 'X', rewindedAt: 1 } }));
    const b = buildReuseKey(baseKeyInput({ rewindState: { cutoffSK: 'X', rewindedAt: 2 } }));
    const aAgain = buildReuseKey(baseKeyInput({ rewindState: { cutoffSK: 'X', rewindedAt: 1 } }));
    expect(a).not.toBe(b);
    expect(a).toBe(aAgain);
  });

  it('changes on model / agentName / sessionId differences', () => {
    const base = buildReuseKey(baseKeyInput());
    expect(buildReuseKey(baseKeyInput({ model: 'other' }))).not.toBe(base);
    expect(buildReuseKey(baseKeyInput({ agentName: 'other' }))).not.toBe(base);
    expect(buildReuseKey(baseKeyInput({ sessionId: 'other' }))).not.toBe(base);
  });

  // Full config / credential / cwd folded into the key.
  it('changes when an MCP server config field changes even if type:name is unchanged', () => {
    const base = buildReuseKey(baseKeyInput());
    const changedArgs = buildReuseKey(
      baseKeyInput({
        mcpServers: [
          { type: 'stdio', name: 'b', command: 'b-cmd', args: ['--b'] },
          { type: 'stdio', name: 'a', command: 'a-cmd', args: ['--a', '--extra'] }, // args changed
        ],
      })
    );
    expect(changedArgs).not.toBe(base);
  });

  it('changes when the API key changes (multi-user billing cross-over guard); key never appears raw', () => {
    const base = buildReuseKey(baseKeyInput({ apiKey: 'api-key-1' }));
    const other = buildReuseKey(baseKeyInput({ apiKey: 'api-key-2' }));
    expect(other).not.toBe(base);
    expect(base).not.toContain('api-key-1'); // hashed, never embedded raw
  });

  it('changes when cwd changes', () => {
    const base = buildReuseKey(baseKeyInput({ cwd: '/work/dir' }));
    const other = buildReuseKey(baseKeyInput({ cwd: '/other/dir' }));
    expect(other).not.toBe(base);
  });

  it('is stable for identical inputs', () => {
    expect(buildReuseKey(baseKeyInput())).toBe(buildReuseKey(baseKeyInput()));
  });
});

describe('KiroAgentPool', () => {
  const KEY = buildReuseKey(baseKeyInput());
  const OTHER_KEY = buildReuseKey(baseKeyInput({ rewindState: { cutoffSK: 'c', rewindedAt: 5 } }));

  it('reuses a healthy, fresh, same-key stored agent', async () => {
    let now = 1000;
    const pool = new KiroAgentPool<FakeAgent>({ now: () => now, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(now);
    await pool.store(KEY, a);

    now = 2000;
    const acquired = await pool.tryAcquire(KEY);
    expect(acquired).toBe(a);
    expect(a.disposed).toBe(false);
  });

  it('recycles (disposes) when the subprocess is dead', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    await pool.store(KEY, a);
    a.kill(); // subprocess died between turns

    const acquired = await pool.tryAcquire(KEY);
    expect(acquired).toBeUndefined();
    expect(a.disposed).toBe(true);
    expect(pool.hasCached()).toBe(false);
  });

  it('recycles when max-age is exceeded', async () => {
    let now = 0;
    const pool = new KiroAgentPool<FakeAgent>({ now: () => now, maxAgeMs: () => 5_000 });
    const a = new FakeAgent(0);
    await pool.store(KEY, a);

    now = 5_000; // exactly at the limit → recycle (>=)
    const acquired = await pool.tryAcquire(KEY);
    expect(acquired).toBeUndefined();
    expect(a.disposed).toBe(true);
  });

  it('recycles when the reuse key changed (e.g. rewind applied)', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    await pool.store(KEY, a);

    const acquired = await pool.tryAcquire(OTHER_KEY);
    expect(acquired).toBeUndefined();
    expect(a.disposed).toBe(true);
  });

  it('store replaces (and disposes) a DIFFERENT cached agent', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    const b = new FakeAgent(0);
    await pool.store(KEY, a);
    await pool.store(KEY, b);
    expect(a.disposed).toBe(true);
    expect(pool.hasCached()).toBe(true);
    const acquired = await pool.tryAcquire(KEY);
    expect(acquired).toBe(b);
  });

  it('storing the SAME agent again (new key) does not dispose it', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    await pool.store(KEY, a);
    await pool.store(OTHER_KEY, a); // e.g. S1 re-key after rotation
    expect(a.disposed).toBe(false);
    expect(await pool.tryAcquire(OTHER_KEY)).toBe(a);
  });

  it('clear disposes and drops the cached agent', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    await pool.store(KEY, a);
    await pool.clear();
    expect(a.disposed).toBe(true);
    expect(pool.hasCached()).toBe(false);
  });

  it('isCached reflects identity of the currently-cached agent', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    const b = new FakeAgent(0);
    expect(pool.isCached(a)).toBe(false);
    await pool.store(KEY, a);
    expect(pool.isCached(a)).toBe(true);
    expect(pool.isCached(b)).toBe(false);
    await pool.clear();
    expect(pool.isCached(a)).toBe(false);
  });
});

describe('tunables', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('kiroProcessReuseEnabled default ON, off-forms disable', () => {
    expect(kiroProcessReuseEnabled()).toBe(true);
    for (const off of ['0', 'false', 'off', 'no']) {
      vi.stubEnv('KIRO_ACP_PROCESS_REUSE', off);
      expect(kiroProcessReuseEnabled()).toBe(false);
    }
    vi.stubEnv('KIRO_ACP_PROCESS_REUSE', 'on');
    expect(kiroProcessReuseEnabled()).toBe(true);
  });

  it('kiroProcessMaxAgeMs default 6h, override honored, invalid falls back', () => {
    expect(kiroProcessMaxAgeMs()).toBe(6 * 60 * 60 * 1000);
    vi.stubEnv('KIRO_ACP_PROCESS_MAX_AGE_MS', '3600000');
    expect(kiroProcessMaxAgeMs()).toBe(3_600_000);
    vi.stubEnv('KIRO_ACP_PROCESS_MAX_AGE_MS', 'bad');
    expect(kiroProcessMaxAgeMs()).toBe(6 * 60 * 60 * 1000);
  });
});
