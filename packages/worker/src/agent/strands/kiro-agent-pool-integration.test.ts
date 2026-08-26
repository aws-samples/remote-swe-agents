/**
 * Loop × pool integration contract.
 *
 * The full `kiroAcpSdkAgentLoop` needs heavy DDB/SSM/subprocess mocking to run
 * end-to-end, so this test exercises the REAL production decision
 * (`decideFinalizeAction`, exported from the loop) against the REAL
 * `KiroAgentPool`, applying the pool op the loop's `finalizeAgent` would apply
 * (store on 'keep', clear/dispose on 'dispose'). It executes production code
 * on both sides — no re-implementation of the keep/dispose policy — and pins
 * the S1 key-alignment that makes a turn-2 reuse actually hit.
 */
import { describe, it, expect } from 'vitest';
import { decideFinalizeAction } from '../kiro-acp-sdk-agent-loop';
import { KiroAgentPool, buildReuseKey, type PoolableAgent, type ReuseKeyInput } from './kiro-agent-pool';

class FakeAgent implements PoolableAgent {
  disposed = false;
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
  }
}

/**
 * Apply the loop's finalize side effects using the REAL `decideFinalizeAction`
 * decision + the REAL pool ops. Mirrors kiroAcpSdkAgentLoop.finalizeAgent's
 * store/clear/dispose wiring (the wiring is trivial; the DECISION — the part
 * that had the bugs — is the real production function).
 */
async function finalize(
  pool: KiroAgentPool<FakeAgent>,
  agent: FakeAgent,
  reason: 'ok' | 'cancelled' | 'error',
  ctx: { reuseEnabled: boolean; synthesisFailed: boolean; currentReuseKey: () => string }
): Promise<void> {
  const action = decideFinalizeAction(reason, {
    reuseEnabled: ctx.reuseEnabled,
    synthesisFailed: ctx.synthesisFailed,
    alive: agent.isAlive(),
  });
  if (action === 'keep') {
    await pool.store(ctx.currentReuseKey(), agent);
    return;
  }
  if (pool.isCached(agent)) await pool.clear();
  else await agent.dispose();
}

const keyInput = (over: Partial<ReuseKeyInput> = {}): ReuseKeyInput => ({
  workerId: 'w1',
  sessionId: 'sess-A',
  model: undefined,
  agentName: 'remote-swe',
  mcpServers: [{ type: 'stdio', name: 'a', command: 'a' }],
  apiKey: 'k1',
  cwd: '/w',
  rewindState: undefined,
  ...over,
});

describe('decideFinalizeAction (real production decision)', () => {
  const base = { reuseEnabled: true, synthesisFailed: false, alive: true };
  it('keeps ONLY on ok + reuse-enabled + non-fallback + alive', () => {
    expect(decideFinalizeAction('ok', base)).toBe('keep');
    expect(decideFinalizeAction('cancelled', base)).toBe('dispose');
    expect(decideFinalizeAction('error', base)).toBe('dispose');
    expect(decideFinalizeAction('ok', { ...base, reuseEnabled: false })).toBe('dispose');
    expect(decideFinalizeAction('ok', { ...base, synthesisFailed: true })).toBe('dispose');
    expect(decideFinalizeAction('ok', { ...base, alive: false })).toBe('dispose');
  });
});

describe('loop × pool — reuse hit after a clean turn (key alignment)', () => {
  it('turn-1 finalize(ok) stores under the effective-sessionId key; turn-2 acquire HITS', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const agent1 = new FakeAgent(0);
    // S1: store under the EFFECTIVE (post-synth) sessionId, not the turn-entry empty one.
    const effectiveKey = () => buildReuseKey(keyInput({ sessionId: 'sess-A' }));
    await finalize(pool, agent1, 'ok', { reuseEnabled: true, synthesisFailed: false, currentReuseKey: effectiveKey });
    expect(pool.isCached(agent1)).toBe(true);

    // Turn 2 acquires with the persisted sessionId → identical key → HIT.
    const acquired = await pool.tryAcquire(buildReuseKey(keyInput({ sessionId: 'sess-A' })));
    expect(acquired).toBe(agent1);
    expect(agent1.disposed).toBe(false);
  });
});

describe('loop × pool — finalize keep/dispose against the real pool', () => {
  const K = () => 'K';

  it('ok + healthy → KEEP (stored, not disposed)', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    await finalize(pool, a, 'ok', { reuseEnabled: true, synthesisFailed: false, currentReuseKey: K });
    expect(a.disposed).toBe(false);
    expect(pool.isCached(a)).toBe(true);
  });

  it('cancelled → DISPOSE + clear (next turn cold-starts; -32603 race avoided)', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    await pool.store('K', a);
    await finalize(pool, a, 'cancelled', { reuseEnabled: true, synthesisFailed: false, currentReuseKey: K });
    expect(a.disposed).toBe(true);
    expect(pool.hasCached()).toBe(false);
  });

  it('synthesis-fallback session is never pooled (disposed even on ok)', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    await finalize(pool, a, 'ok', { reuseEnabled: true, synthesisFailed: true, currentReuseKey: K });
    expect(a.disposed).toBe(true);
    expect(pool.hasCached()).toBe(false);
  });

  it('reuse disabled → ok still disposes', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const a = new FakeAgent(0);
    await finalize(pool, a, 'ok', { reuseEnabled: false, synthesisFailed: false, currentReuseKey: K });
    expect(a.disposed).toBe(true);
  });
});

describe('loop × pool — ladder respawn recycles then re-pools', () => {
  it('finalize(error) on the failed agent clears the slot; the fresh agent is stored on success', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const failed = new FakeAgent(0);
    await pool.store('K', failed); // reused at turn start
    await finalize(pool, failed, 'error', { reuseEnabled: true, synthesisFailed: false, currentReuseKey: () => 'K' });
    expect(failed.disposed).toBe(true);
    expect(pool.hasCached()).toBe(false);

    const fresh = new FakeAgent(1);
    await finalize(pool, fresh, 'ok', { reuseEnabled: true, synthesisFailed: false, currentReuseKey: () => 'K' });
    expect(pool.isCached(fresh)).toBe(true);
    expect(fresh.disposed).toBe(false);
  });

  it('leak fix: finalize(error) on a NON-cached alive agent disposes it directly', async () => {
    const pool = new KiroAgentPool<FakeAgent>({ now: () => 0, maxAgeMs: () => 10_000 });
    const cached = new FakeAgent(0);
    const other = new FakeAgent(0);
    await pool.store('K', cached);
    await finalize(pool, other, 'error', { reuseEnabled: true, synthesisFailed: false, currentReuseKey: () => 'K' });
    expect(other.disposed).toBe(true); // not leaked
    expect(pool.isCached(cached)).toBe(true); // cached entry untouched
  });
});
