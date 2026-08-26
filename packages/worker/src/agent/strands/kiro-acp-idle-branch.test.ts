/**
 * Generator-level integration tests for stream()'s idle branch, driving the
 * REAL stream() + ManualSession (subprocess bypassed via injected fields).
 * Covers: probe no-ack → lethal idle throw; alive-cancelled → reset + re-prompt.
 * (single-waiter reuse is covered by kiro-acp-abandoned-waiter.test.ts;
 *  the toolProbe timer and tick threshold are covered by
 *  watchdog-controller.test.ts + proc-liveness.test.ts.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KiroAcpAgent, ManualSession, type KiroAgentStreamEvent } from './kiro-acp-agent';

const makeAgent = (session: ManualSession, ctx: unknown) => {
  const agent = new KiroAcpAgent();
  (agent as unknown as { ready: Promise<void> }).ready = Promise.resolve();
  (agent as unknown as { session: ManualSession }).session = session;
  (agent as unknown as { ctx: unknown }).ctx = ctx;
  return agent;
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('stream() idle branch integration', () => {
  beforeEach(() => {
    vi.stubEnv('KIRO_ACP_IDLE_TIMEOUT_MS', '30');
    vi.stubEnv('KIRO_ACP_WALL_CLOCK_HARD_MS', '0');
    vi.stubEnv('KIRO_ACP_TOOL_PROBE_INTERVAL_MS', '0');
    vi.stubEnv('KIRO_ACP_PROC_LIVENESS', 'off');
    vi.stubEnv('KIRO_ACP_CANCEL_PROBE', 'on');
    vi.stubEnv('KIRO_ACP_CANCEL_ACK_TIMEOUT_MS', '80');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('probe no-ack (no message within the ack window) → lethal idle-timeout throw', async () => {
    const sessionId = 'idle-noack';
    const notify = vi.fn(async () => {});
    const ctx = { notify, request: vi.fn(() => new Promise(() => {})) } as unknown;
    const session = new ManualSession(sessionId, ctx as never);
    const agent = makeAgent(session, ctx);

    const iter = agent.stream('hi');
    // Never push any message: idle fires → cancel probe sent → no ack within
    // 80ms → confirmed wedge → stream throws the lethal idle error.
    await expect(iter.next()).rejects.toThrow(/idle for/);
    expect(notify).toHaveBeenCalledWith('session/cancel', { sessionId });
  }, 10_000);

  it('a non-cancelled stop arriving in the probe window returns as a COMPLETED turn (no re-prompt)', async () => {
    const sessionId = 'idle-completed';
    let promptCount = 0;
    const ctx = {
      notify: vi.fn(async () => {}),
      request: vi.fn(() => {
        promptCount++;
        return new Promise(() => {});
      }),
    } as unknown;
    const session = new ManualSession(sessionId, ctx as never);
    const agent = makeAgent(session, ctx);

    const iter = agent.stream('hi');
    const first = iter.next();

    // Wait until the probe sent session/cancel.
    const start = Date.now();
    while ((ctx as { notify: ReturnType<typeof vi.fn> }).notify.mock.calls.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
      await flush();
    }
    const promptsBefore = promptCount;
    // A NON-cancelled stop arrives: the turn actually completed during the window.
    (session as unknown as { pushStop: (r: { stopReason: string }) => void })['pushStop']({ stopReason: 'end_turn' });

    // stream() must return a result WITHOUT re-prompting.
    const events: KiroAgentStreamEvent[] = [];
    let n = await first;
    while (!n.done) {
      events.push(n.value);
      n = await iter.next();
    }
    expect(n.value.stopReason).toBe('endTurn');
    expect(promptCount).toBe(promptsBefore); // NOT re-prompted
    expect(events.some((e) => e.type === 'reset')).toBe(false); // completed, not alive-cancelled
  }, 10_000);
});
