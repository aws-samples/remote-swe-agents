/**
 * Abandoned-waiter regression: message loss in stream()'s probe/idle
 * branch, using the REAL ManualSession + real stream().
 *
 * Origin: adapted from a review proof-of-concept. The
 * PoC proved the BUG green (probe reported no-ack because a cancel ack was
 * delivered to the abandoned race waiter). After the fix (a single shared
 * `pendingNext` waiter reused across the race + probe), these tests assert the
 * FIXED behaviour: the cancel ack reaches the probe and stream() recovers
 * non-lethally (re-prompt) instead of throwing the lethal idle error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { KiroAcpAgent, ManualSession } from './kiro-acp-agent';

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

describe('cancel probe vs the (former) abandoned race waiter', () => {
  beforeEach(() => {
    // Idle fires almost immediately; probe window generous; hard wall + proc
    // liveness + tool probe off so only the idle→cancel-probe path is exercised.
    vi.stubEnv('KIRO_ACP_IDLE_TIMEOUT_MS', '30');
    vi.stubEnv('KIRO_ACP_WALL_CLOCK_HARD_MS', '0');
    vi.stubEnv('KIRO_ACP_TOOL_PROBE_INTERVAL_MS', '0');
    vi.stubEnv('KIRO_ACP_PROC_LIVENESS', 'off');
    vi.stubEnv('KIRO_ACP_CANCEL_PROBE', 'on');
    vi.stubEnv('KIRO_ACP_CANCEL_ACK_TIMEOUT_MS', '300');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('cancel ack delivered AFTER idle fired reaches the probe (single shared waiter) → non-lethal re-prompt, no idle throw', async () => {
    const sessionId = 'sess-bl1';
    const notify = vi.fn(async () => {});
    let promptCount = 0;
    const ctx = {
      notify,
      request: vi.fn(() => {
        promptCount++;
        return new Promise(() => {}); // never settles (prompt stays "in flight")
      }),
    } as unknown;
    const session = new ManualSession(sessionId, ctx as never);
    const agent = makeAgent(session, ctx);

    const iter = agent.stream('hi');
    const first = iter.next();

    // Wait until the cancel probe sent session/cancel (idle fired).
    const start = Date.now();
    while (notify.mock.calls.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
      await flush();
    }
    expect(notify).toHaveBeenCalledWith('session/cancel', { sessionId });
    const promptCountAtProbe = promptCount;

    // kiro-cli acks the cancel now (it IS alive). With the single-waiter fix the
    // shared waiter is the probe's, so this ack reaches the probe.
    (session as unknown as { pushStop: (r: { stopReason: string }) => void })['pushStop']({
      stopReason: 'cancelled',
    });

    // The probe recovers non-lethally: stream() emits a `reset` and re-prompts
    // the SAME session (a 2nd session/prompt request), instead of throwing the
    // lethal idle error.
    const resetSeen = { value: false };
    const drain = (async () => {
      let n = await first;
      while (!n.done) {
        if (n.value.type === 'reset') resetSeen.value = true;
        n = await iter.next();
      }
    })();

    const deadline = Date.now() + 2000;
    while (promptCount <= promptCountAtProbe && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
      await flush();
    }

    expect(promptCount).toBeGreaterThan(promptCountAtProbe); // re-prompted same session
    expect(resetSeen.value).toBe(true); // reset emitted before re-prompt

    // Clean up the never-ending generator by returning it.
    await iter.return?.(undefined as never);
    await drain.catch(() => {});
  }, 10_000);

  it('single-waiter invariant: only ONE nextUpdate waiter is outstanding across the race+probe', async () => {
    // Directly exercises ManualSession's waiter FIFO through the shared-pending
    // discipline that stream() now uses: a caller that reuses the SAME pending
    // promise (never abandoning it) always has exactly one waiter, so a pushed
    // message is delivered to that waiter (not starved behind an abandoned one).
    const ctx = { notify: vi.fn(async () => {}), request: vi.fn(() => new Promise(() => {})) } as unknown;
    const session = new ManualSession('s2', ctx as never);

    // Model stream()'s peekNext(): a single shared pending promise, reused.
    let pending: Promise<unknown> | undefined;
    const peekNext = () => (pending ??= session.nextUpdate());

    let firstConsumer: unknown;
    void peekNext().then((m) => (firstConsumer = m));
    // The "race lost to idle" case: we DO NOT abandon pending — the probe reuses it.
    let probeConsumer: unknown;
    void peekNext().then((m) => (probeConsumer = m)); // same promise → same waiter

    session.pushUpdate(chunkNotif('s2', 'the-one-and-only-message'));
    await flush();

    // Both handlers observe the SAME single delivery (same shared promise),
    // and no message is starved behind an abandoned waiter.
    expect(firstConsumer).toBeDefined();
    expect(probeConsumer).toBe(firstConsumer);
  });
});
