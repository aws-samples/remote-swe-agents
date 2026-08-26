/**
 * Tool-interruption integration: drive the REAL KiroAcpAgent.stream() generator (not a
 * re-implementation) through a fake ManualSession + ctx, proving the
 * tool-interruption marker wiring: the dangling toolUse gets a synthetic
 * failed result, the marker text stays visible, and the turn ends cleanly.
 *
 * The subprocess is bypassed by pre-injecting `ready`/`session`/`ctx` so no
 * kiro-cli is spawned. Watchdogs are disabled (idle path not exercised here).
 * We consume the async generator step by step, pushing the next update only
 * once the generator is parked on `nextUpdate()`, so ordering is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import {
  KiroAcpAgent,
  ManualSession,
  TOOL_INTERRUPTED_MARKER,
  TOOL_INTERRUPTED_SYNTH_OUTPUT,
  type KiroAgentStreamEvent,
} from './kiro-acp-agent';

const chunkNotif = (sessionId: string, text: string): SessionNotification =>
  ({
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  }) as unknown as SessionNotification;

const toolCallNotif = (sessionId: string, toolCallId: string): SessionNotification =>
  ({
    sessionId,
    update: { sessionUpdate: 'tool_call', toolCallId, title: 'execute_bash', kind: 'execute' },
  }) as unknown as SessionNotification;

const makeAgent = (session: ManualSession, ctx: unknown) => {
  const agent = new KiroAcpAgent();
  (agent as unknown as { ready: Promise<void> }).ready = Promise.resolve();
  (agent as unknown as { session: ManualSession }).session = session;
  (agent as unknown as { ctx: unknown }).ctx = ctx;
  return agent;
};

/** Let queued microtasks flush so the generator parks on its next await. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('stream() tool-interruption wiring (real generator)', () => {
  beforeEach(() => {
    vi.stubEnv('KIRO_ACP_IDLE_TIMEOUT_MS', '0');
    vi.stubEnv('KIRO_ACP_WALL_CLOCK_HARD_MS', '0');
    vi.stubEnv('KIRO_ACP_PROC_LIVENESS', 'off');
    vi.stubEnv('KIRO_ACP_CANCEL_PROBE', 'off');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('synthesizes a failed result for the in-flight tool and ends the turn on the marker', async () => {
    const sessionId = 'sess-m4';
    const ctx = { notify: vi.fn(), request: vi.fn(() => new Promise(() => {})) } as unknown;
    const session = new ManualSession(sessionId, ctx as never);
    const agent = makeAgent(session, ctx);

    const it = agent.stream('hi');
    const events: KiroAgentStreamEvent[] = [];

    // Kick the generator so it issues session.prompt() and parks on nextUpdate.
    const step1 = it.next();
    await flush();
    session.pushUpdate(toolCallNotif(sessionId, 'tool-1'));
    let r = await step1;
    while (!r.done && r.value.type !== 'tool-call') r = await it.next();
    expect(r.done).toBe(false);
    if (!r.done) events.push(r.value);

    // Next: park again, then push the exact interruption marker chunk.
    const step2 = it.next();
    await flush();
    session.pushUpdate(chunkNotif(sessionId, TOOL_INTERRUPTED_MARKER));
    r = await step2;

    // Drain the rest of the generator (synthetic tool-result, result).
    while (!r.done) {
      events.push(r.value);
      r = await it.next();
    }

    const finalResult = r.value; // AgentResult
    expect(finalResult.stopReason).toBe('endTurn');

    // S2: the marker sentence is kiro-cli's internal control text, NOT model
    // output — its text-delta must be SUPPRESSED (never surfaced to the user).
    const markerDelta = events.find((e) => e.type === 'text-delta' && e.text === TOOL_INTERRUPTED_MARKER);
    expect(markerDelta).toBeUndefined();

    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === 'tool-result') {
      expect(toolResult.toolCallId).toBe('tool-1');
      expect(toolResult.status).toBe('failed');
      expect(toolResult.output).toBe(TOOL_INTERRUPTED_SYNTH_OUTPUT);
    }
  });

  it('a normal chunk that merely mentions the phrase does NOT end the turn early', async () => {
    const sessionId = 'sess-m4b';
    const ctx = { notify: vi.fn(), request: vi.fn(() => new Promise(() => {})) } as unknown;
    const session = new ManualSession(sessionId, ctx as never);
    const agent = makeAgent(session, ctx);

    const it = agent.stream('hi');
    const step1 = it.next();
    await flush();
    session.pushUpdate(chunkNotif(sessionId, `note: "${TOOL_INTERRUPTED_MARKER}" appeared in logs`));
    let r = await step1;
    // Expect a text-delta, NOT a result (turn did not end).
    while (!r.done && r.value.type !== 'text-delta') r = await it.next();
    expect(r.done).toBe(false);

    // Park again and deliver a real stop to complete the turn normally.
    const step2 = it.next();
    await flush();
    (session as unknown as { pushStop: (res: { stopReason: string }) => void }).pushStop({ stopReason: 'end_turn' });
    r = await step2;
    while (!r.done) r = await it.next();
    expect(r.value.stopReason).toBe('endTurn');
  });
});
