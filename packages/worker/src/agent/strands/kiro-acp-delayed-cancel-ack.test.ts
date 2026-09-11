/**
 * Delayed-ack regression: a delayed probe-cancel ack that arrives AFTER the
 * probe took the `alive-updated` branch must be recovered (reset + re-prompt
 * the same session), NOT silently dropped as a `cancelled` terminal.
 *
 * Origin: a review proof-of-concept. On the pre-fix code the recovery
 * branch was DEAD (the `alive-updated` branch spent the single re-prompt
 * budget before the delayed ack arrived, so the ack-recovery condition
 * `cancelProbeRecoveries < MAX` was false → `buildResult('cancelled')` →
 * `emptyTurn()` silent drop). After the fix (an `outstandingProbeCancels`
 * attribution counter that is INDEPENDENT of the re-prompt budget, and which
 * the `alive-updated` branch no longer consumes) the recovery branch is
 * reachable and these expectations pass unchanged. Exercises the REAL
 * ManualSession + real stream().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { KiroAcpAgent, ManualSession, type KiroAgentStreamEvent } from './kiro-acp-agent';

const chunkNotif = (sessionId: string, text: string): SessionNotification =>
  ({
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  }) as unknown as SessionNotification;

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

describe('delayed probe-cancel ack after alive-updated → recovery, not a silent cancelled terminal', () => {
  beforeEach(() => {
    vi.stubEnv('KIRO_ACP_IDLE_TIMEOUT_MS', '30');
    vi.stubEnv('KIRO_ACP_WALL_CLOCK_HARD_MS', '0');
    vi.stubEnv('KIRO_ACP_TOOL_PROBE_INTERVAL_MS', '0');
    vi.stubEnv('KIRO_ACP_PROC_LIVENESS', 'off');
    vi.stubEnv('KIRO_ACP_CANCEL_PROBE', 'on');
    vi.stubEnv('KIRO_ACP_CANCEL_ACK_TIMEOUT_MS', '300');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('alive-updated probe then delayed stop(cancelled) → reset + re-prompt (recovers, not silent drop)', async () => {
    const sessionId = 'sess-nb2';
    const notify = vi.fn(async () => {});
    let promptCount = 0;
    const ctx = {
      notify,
      request: vi.fn(() => {
        promptCount++;
        return new Promise(() => {});
      }),
    } as unknown;
    const session = new ManualSession(sessionId, ctx as never);
    const agent = makeAgent(session, ctx);

    const iter = agent.stream('hi');
    const events: KiroAgentStreamEvent[] = [];
    let done = false;
    let finalStop: string | undefined;
    const consumer = (async () => {
      let n = await iter.next();
      while (!n.done) {
        events.push(n.value);
        n = await iter.next();
      }
      done = true;
      finalStop = (n.value as { stopReason?: string }).stopReason;
    })();

    // Wait for the probe to send session/cancel (idle fired).
    const start = Date.now();
    while (notify.mock.calls.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
      await flush();
    }
    expect(notify).toHaveBeenCalledWith('session/cancel', { sessionId });

    // A real update arrives inside the probe window → probe: alive-updated
    // (does NOT spend the re-prompt budget; the probe cancel stays outstanding).
    session.pushUpdate(chunkNotif(sessionId, 'real progress'));
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(done).toBe(false);

    // The delayed ack of our probe cancel now lands on the normal path.
    (session as unknown as { pushStop: (r: { stopReason: string }) => void }).pushStop({ stopReason: 'cancelled' });
    await new Promise((r) => setTimeout(r, 20));
    await flush();

    // Recovery: a `reset` is emitted and the same session is re-prompted
    // (2nd session/prompt request), instead of a silent cancelled terminal.
    expect(events.some((e) => e.type === 'reset')).toBe(true);
    expect(promptCount).toBe(2);
    expect(done).toBe(false);

    // Complete the re-prompted turn normally.
    (session as unknown as { pushStop: (r: { stopReason: string }) => void }).pushStop({ stopReason: 'end_turn' });
    await consumer;
    expect(finalStop).toBe('endTurn');
  }, 10_000);
});
