/**
 * Tool-boundary regression: `sawToolChild` must be reset at the TOOL BOUNDARY (every
 * message once no tool is in-flight), not only on a 60s tool-probe tick.
 *
 * Pre-fix failure mode: a child-spawning tool (e.g. execute_bash) sets
 * sawToolChild=true; it completes; a following in-process tool (resident MCP,
 * spawns no child) is in-flight when the next tool-liveness tick lands and
 * measures no new descendant → with the STALE sawToolChild=true the verdict is
 * DEAD → the stream throws a (false) wedge error, killing a healthy tool.
 *
 * This drives the REAL stream() + real WatchdogController tool-probe timer, and
 * mocks only the /proc measurement (a true external). Tool A's terminal update
 * and tool B's start are pushed in the SAME synchronous batch so NO probe tick
 * can land while toolsInFlight===0 — therefore ONLY the per-message boundary
 * reset can clear the flag. If the boundary reset is removed, sawToolChild
 * stays true into tool B's probe tick → DEAD throw and this test fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';

let measureCalls = 0;
vi.mock('./proc-liveness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proc-liveness')>();
  return {
    ...actual,
    kiroProcLivenessEnabled: () => true,
    captureBaselinePids: () => new Set<number>(),
    // Tool A phase: a child IS present & active → the real decideToolProbeVerdict
    // records sawChild=true. Tool B phase (globalThis flag flipped): no
    // descendant present → with a STALE sawChild this is DEAD; with a reset one
    // it is WAIT.
    measureNewDescendantActivity: vi.fn(async () => {
      measureCalls++;
      if ((globalThis as Record<string, unknown>).__toolBphase === true) {
        return { present: false, active: false, rootReadable: true };
      }
      return { present: true, active: true, rootReadable: true };
    }),
    probeSubprocessLiveness: vi.fn(async () => 'UNKNOWN' as const),
  };
});

import { KiroAcpAgent, ManualSession, type KiroAgentStreamEvent } from './kiro-acp-agent';

const toolCallNotif = (sessionId: string, toolCallId: string, title: string): SessionNotification =>
  ({
    sessionId,
    update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'other' },
  }) as unknown as SessionNotification;

const toolCompletedNotif = (sessionId: string, toolCallId: string): SessionNotification =>
  ({
    sessionId,
    update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', title: 't' },
  }) as unknown as SessionNotification;

const makeAgent = (session: ManualSession, ctx: unknown) => {
  const agent = new KiroAcpAgent();
  (agent as unknown as { ready: Promise<void> }).ready = Promise.resolve();
  (agent as unknown as { session: ManualSession }).session = session;
  (agent as unknown as { ctx: unknown }).ctx = ctx;
  (agent as unknown as { getPid: () => number }).getPid = () => 123;
  return agent;
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('sawToolChild is reset at the tool boundary (no false DEAD for a following in-process tool)', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__toolBphase = false;
    measureCalls = 0;
    vi.stubEnv('KIRO_ACP_IDLE_TIMEOUT_MS', '0');
    vi.stubEnv('KIRO_ACP_WALL_CLOCK_HARD_MS', '0');
    vi.stubEnv('KIRO_ACP_TOOL_PROBE_INTERVAL_MS', '15');
    vi.stubEnv('KIRO_ACP_CANCEL_PROBE', 'off');
    vi.stubEnv('KIRO_ACP_PROC_LIVENESS', 'on');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    delete (globalThis as Record<string, unknown>).__toolBphase;
  });

  it('tool A (child) completes and tool B (in-process) starts in one batch; B probe tick → WAIT, not DEAD', async () => {
    const sessionId = 'boundary';
    const ctx = { notify: vi.fn(async () => {}), request: vi.fn(() => new Promise(() => {})) } as unknown;
    const session = new ManualSession(sessionId, ctx as never);
    const agent = makeAgent(session, ctx);

    const iter = agent.stream('hi');
    const events: KiroAgentStreamEvent[] = [];
    let threw: unknown;
    let done = false;
    const consumer = (async () => {
      try {
        let n = await iter.next();
        while (!n.done) {
          events.push(n.value);
          n = await iter.next();
        }
      } catch (e) {
        threw = e;
      } finally {
        done = true;
      }
    })();

    // Let the stream enter its race loop before pushing messages.
    await new Promise((r) => setTimeout(r, 20));

    // Tool A: child-spawning tool starts; let probe ticks observe the child so
    // the real state machine records sawToolChild = true.
    session.pushUpdate(toolCallNotif(sessionId, 'toolA', 'execute_bash'));
    await new Promise((r) => setTimeout(r, 60));
    await flush();
    const callsAfterA = measureCalls;
    expect(callsAfterA).toBeGreaterThan(0); // tool-probe path ran during tool A

    // Switch the /proc mock to "no descendant" (tool B is in-process), THEN in
    // ONE synchronous batch complete tool A and start tool B. No probe tick can
    // land while toolsInFlight===0, so only the per-message boundary reset can
    // clear sawToolChild.
    (globalThis as Record<string, unknown>).__toolBphase = true;
    session.pushUpdate(toolCompletedNotif(sessionId, 'toolA'));
    session.pushUpdate(toolCallNotif(sessionId, 'toolB', 'fetch'));
    await flush();

    // Let several probe ticks land while tool B is in-flight.
    await new Promise((r) => setTimeout(r, 80));
    await flush();

    expect(measureCalls).toBeGreaterThan(callsAfterA); // B-phase ticks actually ran
    expect(threw).toBeUndefined(); // fix: WAIT, not a false DEAD throw
    expect(done).toBe(false);

    // Finish cleanly.
    (session as unknown as { pushStop: (r: { stopReason: string }) => void }).pushStop({ stopReason: 'end_turn' });
    await consumer;
    expect(threw).toBeUndefined();
  }, 15_000);
});
