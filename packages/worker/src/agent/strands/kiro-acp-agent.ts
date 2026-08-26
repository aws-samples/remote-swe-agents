/**
 * KiroAcpAgent — Strands-`Agent`-compatible wrapper over `kiro-cli acp`
 * =====================================================================
 * Presents the same public call shape as Strands' `Agent` (`invoke(args) =>
 * Promise<AgentResult>` and `stream(args) => AsyncGenerator<..., AgentResult>`),
 * built on the official ACP SDK's high-level `ActiveSession`.
 *
 * Design: the compatibility point is the invoke/stream
 * signature (the SDK's internal `InvokableAgent` contract). `invoke()` returns
 * a REAL Strands `AgentResult` (public classes). `stream()` yields our OWN
 * discriminated union `KiroAgentStreamEvent`, NOT Strands' `StreamEvent`
 * subclasses (those require a brand-guarded `LocalAgent` and are @internal —
 * faking them is an SDK contract violation).
 *
 * Tool-output decoding delegates to the shared agent-core decoder (v2+v3).
 */
import { AgentResult, Message, TextBlock, type StopReason as StrandsStopReason } from '@strands-agents/sdk';
import {
  client,
  ndJsonStream,
  type ActiveSession,
  type ActiveSessionMessage,
  type ClientContext,
  type ContentBlock as AcpContentBlock,
  type PromptResponse,
  type RequestPermissionOutcome,
  type SessionNotification,
  type SessionUpdate,
  type StopReason as AcpStopReason,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';

/** Prompt input accepted by `stream`/`invoke`: plain text or ACP content blocks. */
export type KiroAcpPromptInput = string | AcpContentBlock | AcpContentBlock[];
import {
  decodeKiroToolOutput,
  type KiroPromptResult,
  type KiroToolCall,
  type KiroToolCallEvent,
} from '@remote-swe-agents/agent-core/lib';
import { spawnKiroAcpProcess, type KiroAcpProcessOptions, type KiroAcpProcessHandle } from './kiro-acp-transport';
import { WatchdogController } from './watchdog-controller';
import {
  probeSubprocessLiveness,
  kiroProcLivenessEnabled,
  captureBaselinePids,
  measureNewDescendantActivity,
  decideToolProbeVerdict,
  initialToolProbeState,
  DEAD_ABSENT_STREAK_THRESHOLD,
} from './proc-liveness';
import { parseMsEnv, parseBoolEnvDefaultOn } from './env-parse';

/**
 * Resolve the init/handshake timeout (ms). Env-overridable via
 * `KIRO_ACP_INITIALIZE_TIMEOUT_MS` (legacy-compatible name), default 120s to
 * accommodate EC2 cold-start (kiro-cli runs as a separate binary, not a
 * pre-warmed container, so its handshake can take 60-90s). `0` disables the
 * timeout entirely (falls back to the outer turn wall-clock, legacy parity).
 */
export const resolveInitTimeoutMs = (): number => parseMsEnv('KIRO_ACP_INITIALIZE_TIMEOUT_MS', 120_000);

/**
 * NOTE (production-dead as of the main integration): the LIVE setup-phase bound
 * is now {@link awaitSessionOpen} → {@link withTimeout} (labels `initialize` /
 * `session/new` / `session/load`), NOT this helper. `buildInitTimeoutError` /
 * {@link raceWithInitTimeout} are retained ONLY so the
 * `kiro-acp-init-timeout.test.ts` contract keeps compiling/passing; they are
 * not called on any runtime path. If that test is ever retired, delete both.
 * The equivalent live-wording classifier assertions now live in the same test
 * to prevent a "helper green while live wiring dies" regression.
 *
 * Build the identifiable error thrown when the kiro-cli `initialize` /
 * `session/new` / `session/load` handshake does not complete within the init
 * timeout. The timeout converts an unbounded init hang into a bounded failure;
 * recovery then follows the existing D5 self-heal chain, NOT an in-turn respawn:
 * the loop's `agent.start()` call sites all `throw` on failure (start-phase
 * catch → clear the persisted `kiroSessionId` → dispose → throw), the turn ends
 * with the canonical UX phrase, and the NEXT turn recovers with a fresh UUID +
 * DDB re-synthesis. The wording is deliberately matched by BOTH classifiers so
 * that chain works and a future prompt-phase caller is also covered:
 *   - `isKnownKiroInternalError` matches the `kiro-cli` marker → the terminal
 *     init failure reaching `handleTurnError` is collapsed to the canonical UX
 *     phrase instead of leaking the raw handshake error (the actual path today).
 *   - `isPromptTimeoutOrIdleError` matches the `timed out` substring → forward
 *     defence: if a future caller surfaces this error on the prompt-phase retry
 *     path, it is already classified as retryable there.
 */
export const buildInitTimeoutError = (timeoutMs: number): Error =>
  new Error(
    `Kiro ACP initialize (kiro-cli handshake) timed out after ${timeoutMs}ms — ` +
      `subprocess unresponsive during session start`
  );

/**
 * Race `work` against an init-timeout timer. Resolves with `work`'s value when
 * it settles first; rejects with {@link buildInitTimeoutError} when the timer
 * wins. `timeoutMs <= 0` disables the timer and simply awaits `work`. The timer
 * is always cleared so a slow-but-successful handshake leaves no dangling timer.
 */
export const raceWithInitTimeout = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  if (timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(buildInitTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Our own stream-event union. Mirrors the granularity of Strands' stream events
 * (text delta, tool lifecycle, final result) but carries ACP-native payloads
 * and no `LocalAgent` reference. Discriminated on `type`.
 */
export type KiroAgentStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; name: string; title: string; kind?: string; rawInput?: unknown }
  | {
      type: 'tool-result';
      toolCallId: string;
      status: string;
      title: string;
      output?: string;
      rawOutput?: unknown;
    }
  | { type: 'usage'; used: number; size: number; percentage: number }
  // Emitted by stream() right before an alive-cancelled re-prompt on the
  // SAME session, so the consumer (promptCompat / the loop's fan-out) can
  // discard any partial text/tool bookkeeping accumulated by the aborted
  // attempt before the re-prompt streams the turn again — otherwise the
  // pre-cancel text would be double-counted.
  | { type: 'reset' }
  | { type: 'result'; result: AgentResult };

export interface KiroAcpAgentOptions extends KiroAcpProcessOptions {
  id?: string;
  name?: string;
  description?: string;
  mcpServers?: Array<{ type: string; name: string; [key: string]: unknown }>;
  /** If provided, use session/load instead of session/new to resume an existing session. */
  sessionId?: string;
}

/**
 * Common interface satisfied by both ActiveSession (session/new) and ManualSession
 * (session/load resume). Lets stream()/promptCompat() consume either path uniformly.
 */
interface SessionLike {
  readonly sessionId: string;
  prompt(input: string | AcpContentBlock | AcpContentBlock[]): void;
  nextUpdate(): Promise<ActiveSessionMessage>;
  dispose(): void;
}

/**
 * Thin ActiveSession-equivalent for the session/load resume path. The SDK's
 * ActiveSession has a private constructor tied to session/new; ManualSession
 * provides the same prompt + nextUpdate contract backed by a raw session/load
 * + connection-level session/update notification routing.
 *
 * Cross-session bleed prevention: pushUpdate filters strictly by sessionId.
 */
export class ManualSession implements SessionLike {
  readonly sessionId: string;
  private readonly ctx: ClientContext;
  private readonly queue: ActiveSessionMessage[] = [];
  private readonly waiters: Array<{ resolve: (msg: ActiveSessionMessage) => void; reject: (err: Error) => void }> = [];
  private error?: Error;

  constructor(sessionId: string, ctx: ClientContext) {
    this.sessionId = sessionId;
    this.ctx = ctx;
  }

  /** Push a session/update notification into the queue (sessionId already verified by caller). */
  pushUpdate(notification: SessionNotification): void {
    const msg: ActiveSessionMessage = { kind: 'session_update', notification, update: notification.update };
    if (this.waiters.length > 0) {
      this.waiters.shift()!.resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /** Push a stop message when session/prompt resolves. */
  private pushStop(response: PromptResponse): void {
    const msg: ActiveSessionMessage = { kind: 'stop', response, stopReason: response.stopReason };
    if (this.waiters.length > 0) {
      this.waiters.shift()!.resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /** Reject all pending waiters with an error (D4: prompt failure propagation). */
  private rejectWaiters(err: Error): void {
    this.error = err;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(err);
    }
  }

  prompt(input: string | AcpContentBlock | AcpContentBlock[]): void {
    // D1: drain any residual notifications queued during session/load (replay bleed).
    // These historical updates don't belong to the current prompt turn and must not
    // be consumed by nextUpdate() after this prompt fires.
    this.queue.length = 0;
    const prompt: AcpContentBlock[] =
      typeof input === 'string'
        ? [{ type: 'text', text: input } as AcpContentBlock]
        : Array.isArray(input)
          ? input
          : [input];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (this.ctx.request as any)('session/prompt', { sessionId: this.sessionId, prompt })
      .then((res: PromptResponse) => this.pushStop(res))
      .catch((err: Error) => {
        this.rejectWaiters(err);
      });
  }

  async nextUpdate(): Promise<ActiveSessionMessage> {
    if (this.error) throw this.error;
    if (this.queue.length > 0) return this.queue.shift()!;
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  dispose(): void {
    this.queue.length = 0;
    this.waiters.length = 0;
    this.error = undefined;
  }
}

/** Map an ACP StopReason onto Strands' StopReason string union. */
function mapStopReason(acp: AcpStopReason): StrandsStopReason {
  switch (acp) {
    case 'end_turn':
      return 'endTurn';
    case 'max_tokens':
      return 'maxTokens';
    case 'cancelled':
      return 'cancelled';
    case 'refusal':
      return 'refusal';
    case 'max_turn_requests':
      return 'limitTurns';
    default:
      return acp as StrandsStopReason;
  }
}

/**
 * Extract a tool result string from an ACP `tool_call_update`. Priority order
 * matches the `extractToolCallOutput` of the former hand-written kiro ACP client:
 *   1. rawOutput (kiro dialect decoder, v2+v3) — the PRIMARY source for kiro-cli
 *   2. ACP-spec `content[]` — nested ToolCallContent blocks (text / diff /
 *      flattened text). Handles `{ type:'content', content:{type:'text', text} }`,
 *      bare `{ type:'text', text }`, and `{ type:'diff', newText }` variants.
 *   3. Legacy `output` field — a plain string / `{text}` object fallback.
 *
 * Parity note: this function's priority order and path coverage matches
 * the former hand-written client exactly (rawOutput first, content[] second, output third).
 */
function extractToolOutput(update: ToolCallUpdate): string | undefined {
  // 1. rawOutput (kiro dialect decoder — PRIMARY for kiro-cli 2.x / v3).
  const rawOutput = (update as { rawOutput?: unknown }).rawOutput;
  if (rawOutput !== undefined && rawOutput !== null) {
    const fromRaw = decodeKiroToolOutput(rawOutput);
    if (fromRaw !== undefined) return fromRaw;
  }

  // 2. ACP-spec content[] — nested ToolCallContent blocks.
  const content = (update as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      // { type: 'content', content: { type: 'text', text: '...' } }
      const inner = e.content;
      if (inner && typeof inner === 'object') {
        const text = (inner as { text?: unknown }).text;
        if (typeof text === 'string' && text.length > 0) parts.push(text);
      }
      // Flattened fallback: { type: 'text', text: '...' }
      const text = (e as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) parts.push(text);
      // Diff content: { type: 'diff', path, oldText, newText } — surface the new text
      if (e.type === 'diff' && typeof e.newText === 'string' && (e.newText as string).length > 0) {
        parts.push(e.newText as string);
      }
    }
    if (parts.length > 0) return parts.join('');
  }

  // 3. Legacy: a plain `output` string / object that some ACP agents set directly.
  const direct = (update as { output?: unknown }).output;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (direct && typeof direct === 'object') {
    const text = (direct as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) return text;
  }

  return undefined;
}

/**
 * At most one non-lethal cancel-probe recovery per `stream()` call. If the
 * idle watchdog fires again after a recovery re-prompt, the subprocess is
 * treated as a confirmed wedge (surfaced as the idle-timeout error) so the
 * loop's ladder respawns rather than looping forever on a genuinely stuck CLI.
 */
const MAX_CANCEL_PROBE_RECOVERIES = 1;

/** Bounded wait (ms) for a `session/cancel` ack in the cancel probe (default 5000). */
export const kiroCancelAckTimeoutMs = (): number => parseMsEnv('KIRO_ACP_CANCEL_ACK_TIMEOUT_MS', 5000);

/**
 * c5: env-tunable session-setup timeouts. The ACP SDK's `request()` has no
 * built-in application timeout (only a cooperative cancellationSignal), so a
 * stuck `initialize` / `session/new` / `session/load` would hang the turn
 * indefinitely. We bound each phase and surface a distinct, retryable error so
 * the loop's start-phase handling can recover.
 *
 * `session/load` default is raised to 120s (was an implicit 30s in the legacy
 * client): a resume re-registers every MCP server, which can be slow to
 * initialize. `initialize` (which the SDK performs inside connectWith) and
 * `session/new` keep their historical defaults but become tunable.
 * `0` disables a given timeout.
 */
// Delegates to resolveInitTimeoutMs so the KIRO_ACP_INITIALIZE_TIMEOUT_MS
// env has a SINGLE source of truth after the main integration (both read the
// same legacy-compatible name + 120s default).
export const kiroInitializeTimeoutMs = (): number => resolveInitTimeoutMs();
export const kiroSessionNewTimeoutMs = (): number => parseMsEnv('KIRO_ACP_SESSION_NEW_TIMEOUT_MS', 30_000);
export const kiroSessionLoadTimeoutMs = (): number => parseMsEnv('KIRO_ACP_SESSION_LOAD_TIMEOUT_MS', 120_000);

/**
 * Compute the outer `initialize` ceiling. The per-phase inner timeouts
 * (session/load, session/new) are the authoritative bounds; the outer ceiling
 * only guards the connect + handshake BEFORE those ops run, so it must be
 * strictly larger than any inner bound or it would pre-empt (and mislabel) an
 * inner phase as 'initialize'. Returns 0 (disabled) only when the configured
 * initialize bound is 0. Exported for unit testing.
 */
export function computeOuterCeilingMs(t: {
  initializeMs: number;
  sessionLoadMs: number;
  sessionNewMs: number;
}): number {
  if (t.initializeMs <= 0) return 0;
  return t.initializeMs + Math.max(t.sessionLoadMs, t.sessionNewMs, 0);
}

/**
 * Await the session-open phase, surfacing a connect-phase FAILURE
 * immediately. `opened` only ever RESOLVES (from inside connectWith after the
 * session opens); a failure in connect/initialize/session-load/new rejects
 * `connectionDone` instead. Racing the two makes such a rejection propagate
 * with its real label (e.g. 'session/load timed out ...') rather than hanging
 * until the outer bound mislabels it 'initialize'. The whole race is wrapped in
 * the outer ceiling ({@link computeOuterCeilingMs}) so a stall BEFORE the inner
 * ops still fails fast. Exported for unit testing.
 */
export async function awaitSessionOpen(
  opened: Promise<void>,
  connectionDone: Promise<void> | undefined,
  timeouts: { initializeMs: number; sessionLoadMs: number; sessionNewMs: number },
  isOpen?: () => boolean
): Promise<void> {
  // S4: distinguish the two ways the race can settle. `opened` resolving means
  // the session was established. `connectionDone` resolving FIRST means the
  // connection tore down BEFORE the session opened (a connectWith callback that
  // returned/threw without establishing a session). If we returned silently the
  // caller would proceed with `this.session` undefined and hit a confusing
  // later TypeError; instead throw an explicit, correctly-labelled error.
  const connectionSettled = connectionDone ?? Promise.resolve();
  const OPENED = Symbol('opened');
  const CONNECTION_ENDED = Symbol('connection-ended');
  const outcome = await withTimeout(
    Promise.race([opened.then(() => OPENED), connectionSettled.then(() => CONNECTION_ENDED)]),
    computeOuterCeilingMs(timeouts),
    'initialize'
  );
  if (outcome === CONNECTION_ENDED && (isOpen ? !isOpen() : true)) {
    throw new Error(
      'Kiro ACP connection ended before a session was established (connect/initialize/session-open failed)'
    );
  }
}

/**
 * Race `p` against a `timeoutMs` deadline. `timeoutMs <= 0` disables the bound
 * (returns `p` unchanged). On timeout the returned promise rejects with an
 * Error whose message contains `label` and the ms, so it is greppable/loggable.
 * The underlying `p` is NOT cancelled (the SDK settles it on the eventual
 * peer response); we only stop WAITING on it. Exported for unit testing.
 */
export async function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol('timeout');
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const r = await Promise.race([p, timeout]);
    if (r === TIMED_OUT) {
      // The message MUST carry a kiro-specific marker so the terminal
      // start-phase failure is collapsed to the canonical UX phrase by
      // `isKnownKiroInternalError` (its `hasKiroMarker` gate) instead of leaking
      // the raw handshake error to Slack/webapp — the regression
      // `buildInitTimeoutError` guarded against. `(kiro-cli)` satisfies
      // the `kiro-cli` marker, and `timed out` keeps `isPromptTimeoutOrIdleError`
      // (forward defence on the prompt-phase retry path) true.
      throw new Error(`Kiro ACP ${label} (kiro-cli) timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    return r as T;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Bounded grace (ms) for each await inside {@link KiroAcpAgent.dispose}
 * (graceful connection teardown, then post-SIGKILL exit reaping). `0` disables
 * the bound (await unboundedly — legacy behaviour). Env
 * `KIRO_ACP_DISPOSE_GRACE_MS`, default 5000.
 */
export const disposeGraceMs = (): number => parseMsEnv('KIRO_ACP_DISPOSE_GRACE_MS', 5000);

/**
 * Resolve when `p` settles OR after `timeoutMs`, whichever comes first —
 * WITHOUT rejecting on timeout (unlike {@link withTimeout}). Used by dispose()
 * to cap teardown/exit waits: a wedged subprocess must never hang finalize. The
 * underlying `p` is not cancelled; we simply stop waiting. `timeoutMs <= 0`
 * awaits `p` unbounded. Exported for unit testing.
 */
export async function settleWithin<T>(p: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const DONE = Symbol('settle-timeout');
  const timeout = new Promise<typeof DONE>((resolve) => {
    timer = setTimeout(() => resolve(DONE), timeoutMs);
  });
  try {
    const r = await Promise.race([p, timeout]);
    return r === DONE ? undefined : (r as T);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Whether the non-lethal cancel probe is enabled (default ON). Set
 * `KIRO_ACP_CANCEL_PROBE=off` to fall back to the legacy behaviour where an
 * idle watchdog fire immediately surfaces as a (lethal) idle-timeout error.
 */
export const kiroCancelProbeEnabled = (): boolean => parseBoolEnvDefaultOn('KIRO_ACP_CANCEL_PROBE');

/**
 * Pure interpretation of the first message observed during the cancel probe
 * window. Three outcomes:
 *   - `alive-cancelled`: a `stop` with stopReason `cancelled` — kiro-cli acked
 *     our `session/cancel`, so the subprocess is alive and the in-flight prompt
 *     was aborted. The caller re-prompts the SAME session (with a reset).
 *   - `completed`: a `stop` with ANY OTHER stopReason (`end_turn`,
 *     `max_tokens`, ...) — the prompt turn actually FINISHED during the probe
 *     window (the agent was merely slow, not wedged). The caller must return
 *     this as the turn result, NOT re-prompt: re-prompting would re-run a
 *     completed turn and double its side effects.
 *   - `alive-updated` (+ `pending`): a `session_update` — the subprocess is
 *     alive and produced real progress; the caller consumes the pending update
 *     through the normal streaming path.
 * Exported for unit testing.
 */
export function interpretCancelProbeMessage(msg: ActiveSessionMessage): {
  outcome: 'alive-cancelled' | 'completed' | 'alive-updated';
  pending?: SessionUpdate;
  stopMessage?: ActiveSessionMessage & { kind: 'stop' };
} {
  if (msg.kind === 'stop') {
    if (msg.stopReason === 'cancelled') {
      return { outcome: 'alive-cancelled', stopMessage: msg };
    }
    return { outcome: 'completed', stopMessage: msg };
  }
  return { outcome: 'alive-updated', pending: msg.update };
}

/**
 * kiro-cli's built-in security filter can interrupt tool execution and,
 * instead of completing the `session/prompt`, emit this EXACT sentence as a
 * plain `agent_message_chunk` and then never send the prompt completion — the
 * turn hangs until the idle watchdog fires. kiro-cli emits this literal string
 * itself (it is fact data, not model prose). We match on the trimmed chunk
 * being EXACTLY this marker (mirroring KiroCrew's `chunk.strip() == MARKER`) so
 * a model that merely quotes the phrase inside a longer sentence does not
 * trigger a false interruption.
 */
export const TOOL_INTERRUPTED_MARKER = 'Tool uses were interrupted, waiting for the next user prompt';

/** Synthetic tool-result output attached to the in-flight tools we fail on interruption. */
export const TOOL_INTERRUPTED_SYNTH_OUTPUT =
  '[Tool execution was interrupted by kiro-cli before completing; no result was produced.]';

/**
 * True when `text` is EXACTLY the kiro-cli tool-interruption marker (after
 * trimming). Exported for unit testing.
 *
 * LIMITATION (accepted): detection is per-chunk exact-match. If a future
 * kiro-cli build splits the marker across MULTIPLE `agent_message_chunk`s
 * (e.g. "Tool uses were interrupted," + " waiting for the next user prompt"),
 * no single chunk equals the marker and detection is missed — the turn then
 * falls back to the idle watchdog + cancel probe for recovery. We keep the
 * strict per-chunk match deliberately: it is the exact behaviour kiro-cli
 * exhibits today (single chunk) and avoids the false positives a fuzzy
 * cross-chunk buffer accumulator would introduce (e.g. the model quoting the
 * phrase). Revisit only if kiro-cli is observed splitting the marker.
 */
export const isToolInterruptedMarker = (text: string): boolean => text.trim() === TOOL_INTERRUPTED_MARKER;

/**
 * Build synthetic terminal `tool-result` events (status `failed`) for every
 * still-in-flight tool id, so the loop persists a `toolResult` for each
 * dangling `toolUse` (a toolUse without a matching toolResult corrupts the
 * conversation) and the turn can end cleanly. Pure. Exported for unit testing.
 */
export const buildInterruptedToolResults = (inFlightToolIds: Iterable<string>): KiroAgentStreamEvent[] => {
  const out: KiroAgentStreamEvent[] = [];
  for (const toolCallId of inFlightToolIds) {
    out.push({ type: 'tool-result', toolCallId, status: 'failed', title: '', output: TOOL_INTERRUPTED_SYNTH_OUTPUT });
  }
  return out;
};

/**
 * A single agent instance wrapping one long-lived kiro-cli acp subprocess and
 * one ACP session (reused across turns for multi-turn continuity).
 */
export class KiroAcpAgent {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;

  /** Wall-clock ms at construction — used by the agent pool for max-age recycling. */
  readonly createdAt: number = Date.now();

  private readonly options: KiroAcpAgentOptions;
  private handle?: KiroAcpProcessHandle;
  private ready?: Promise<void>;
  private ctx?: ClientContext;
  private session?: SessionLike;
  private manualSession?: ManualSession;
  private closeConnection?: () => void;
  private connectionDone?: Promise<void>;
  private latestUsage?: { used: number; size: number; percentage: number };
  private disposed = false;

  constructor(options: KiroAcpAgentOptions = {}) {
    this.options = options;
    this.id = options.id ?? `kiro-acp-${Math.random().toString(36).slice(2, 10)}`;
    this.name = options.name;
    this.description = options.description;
  }

  /**
   * Whether this agent's subprocess is still alive and usable across turns
   * (process reuse). False once disposed, before start, or after the
   * kiro-cli subprocess has exited. The agent pool consults this before handing a
   * cached agent to a new turn so a dead process is never reused.
   */
  isAlive(): boolean {
    if (this.disposed) return false;
    const proc = this.handle?.proc;
    if (!proc) return false;
    return proc.exitCode === null && proc.signalCode === null && !proc.killed;
  }

  /**
   * Explicitly start the subprocess + session. Separates the load phase from
   * prompting so callers can distinguish load errors (stale-ID, D5) from prompt
   * errors (transient, session healthy).
   */
  async start(): Promise<void> {
    return this.ensureStarted();
  }

  /** Lazily spawn the subprocess, connect the ACP client, and open a session. */
  private ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const handle = spawnKiroAcpProcess(this.options);
      this.handle = handle;
      const stream = ndJsonStream(handle.writable, handle.readable);

      const app = client({ name: 'remote-swe-agents' })
        .onRequest('session/request_permission', ({ params }) => {
          const options = params.options ?? [];
          const allow = options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once');
          const outcome: RequestPermissionOutcome = allow
            ? { outcome: 'selected', optionId: allow.optionId }
            : { outcome: 'cancelled' };
          return { outcome };
        })
        // kiro-cli's non-standard context-usage notification (ACP `usage_update`
        // is NOT emitted by kiro-cli). Registered as a custom notification.
        .onNotification(
          '_kiro.dev/metadata',
          (raw) => raw,
          ({ params }) => {
            const p = params as { contextUsagePercentage?: number } | undefined;
            if (p && typeof p.contextUsagePercentage === 'number') {
              this.latestUsage = { used: p.contextUsagePercentage, size: 100, percentage: p.contextUsagePercentage };
            }
          }
        )
        // session/update routing for the ManualSession (resume) path. For the
        // session/new path, ActiveSession handles routing internally. When no
        // ManualSession is active, notifications are harmlessly dropped.
        .onNotification(
          'session/update',
          (raw) => raw,
          ({ params }) => {
            const p = params as SessionNotification | undefined;
            if (p && this.manualSession && p.sessionId === this.manualSession.sessionId) {
              this.manualSession.pushUpdate(p);
            }
          }
        );

      const opened = new Promise<void>((resolveOpened) => {
        this.connectionDone = app.connectWith(stream, async (ctx) => {
          this.ctx = ctx;
          const sessionCwd = this.options.cwd ?? `${process.env.HOME || '/tmp'}/.remote-swe-workspace`;
          const mcpServers = this.options.mcpServers ?? [];
          console.log(
            `[kiro-acp-agent] ${this.options.sessionId ? 'loadSession' : 'buildSession'} cwd=${sessionCwd} mcpServers.length=${mcpServers.length}` +
              (mcpServers.length > 0 ? ` names=${JSON.stringify(mcpServers.map((s) => s.name))}` : '')
          );

          if (this.options.sessionId) {
            // Resume path: session/load with synthesized session files.
            // c5: bound the load (MCP re-registration can be slow; default 120s).
            await withTimeout(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (ctx.request as any)('session/load', {
                sessionId: this.options.sessionId,
                cwd: sessionCwd,
                mcpServers,
              }),
              kiroSessionLoadTimeoutMs(),
              'session/load'
            );
            const ms = new ManualSession(this.options.sessionId, ctx);
            this.manualSession = ms;
            this.session = ms;
            console.log(`[kiro-acp-agent] session loaded: ${this.options.sessionId}`);
          } else {
            // New session path. c5: bound session/new (default 30s).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.session = await withTimeout(
              ctx.buildSession({ cwd: sessionCwd, mcpServers } as any).start(),
              kiroSessionNewTimeoutMs(),
              'session/new'
            );
          }

          await new Promise<void>((resolveClose) => {
            this.closeConnection = resolveClose;
            resolveOpened();
          });
        });
      });
      // Phase-split init bound (supersedes the single-race raceWithInitTimeout
      // at this call site; those helpers remain exported + unit-tested below):
      //
      // `opened` only ever RESOLVES (from inside the connectWith
      // callback, after the session is open); it never rejects. A failure in
      // the connect→initialize→session-load/new phase rejects `connectionDone`
      // instead. Racing the two makes such a rejection surface IMMEDIATELY
      // (with its real 'session/load' / 'session/new' label) instead of
      // hanging until the outer timeout mislabels it 'initialize'.
      //
      // The per-phase inner timeouts (session/load default 120s,
      // session/new default 30s) are the AUTHORITATIVE bounds — their
      // rejections now propagate via `connectionDone`, so they are no longer
      // dead code under the outer bound. The outer `initialize` ceiling
      // (KIRO_ACP_INITIALIZE_TIMEOUT_MS, the same legacy-compatible env name)
      // covers the connect + handshake so a stall BEFORE the inner
      // ops (e.g. the transport never yielding a ctx) still fails fast. It is
      // sized as initializeBound + the largest inner bound so it can never
      // pre-empt (and thus mislabel) an inner phase. The outer-timeout error
      // still carries the `timed out` substring, so it stays classified as a
      // retryable init/idle error exactly like buildInitTimeoutError
      // (the retry-ladder classification contract is preserved).
      await awaitSessionOpen(
        opened,
        this.connectionDone,
        {
          initializeMs: kiroInitializeTimeoutMs(),
          sessionLoadMs: kiroSessionLoadTimeoutMs(),
          sessionNewMs: kiroSessionNewTimeoutMs(),
        },
        () => this.session !== undefined
      );
    })();
    return this.ready;
  }

  /**
   * Stream one prompt turn. Yields KiroAgentStreamEvent and returns the final
   * AgentResult (matching Strands' `stream` return contract).
   */
  async *stream(
    args: KiroAcpPromptInput,
    options?: { cancelSignal?: AbortSignal; canReprompt?: () => boolean }
  ): AsyncGenerator<KiroAgentStreamEvent, AgentResult, undefined> {
    await this.ensureStarted();
    const session = this.session!;
    const ctx = this.ctx!;

    // AbortSignal -> ACP session/cancel mapping.
    const onAbort = () => {
      void ctx.notify('session/cancel', { sessionId: session.sessionId });
    };
    if (options?.cancelSignal) {
      if (options.cancelSignal.aborted) onAbort();
      else options.cancelSignal.addEventListener('abort', onAbort, { once: true });
    }

    // Watchdog: extracted to WatchdogController for testability.
    const watchdog = new WatchdogController();

    // Non-lethal stuck recovery. When the IDLE watchdog fires we do NOT
    // immediately treat the subprocess as dead. We first send `session/cancel`
    // and wait a bounded time for kiro-cli to acknowledge (a `stop` with
    // stopReason `cancelled`, or any real update proving it is alive). An ack
    // means the subprocess was alive but silent → preserve it and re-prompt
    // the same session. No ack within the bound → confirmed wedge → throw the
    // idle-timeout error so the loop's ladder disposes + respawns + resumes.
    // The hard wall-clock (watchdog.failure) is unchanged and always lethal.
    const cancelProbeEnabled = kiroCancelProbeEnabled();
    const cancelAckTimeoutMs = kiroCancelAckTimeoutMs();
    const procLivenessEnabled = kiroProcLivenessEnabled();
    const canReprompt = options?.canReprompt ?? (() => true);
    // Re-prompt BUDGET: how many times we have re-prompted the same session on
    // this stream (bounded by MAX_CANCEL_PROBE_RECOVERIES). Distinct from the
    // ack-attribution counter below.
    let cancelProbeRecoveries = 0;
    // ACK ATTRIBUTION, separate from the re-prompt
    // budget. Incremented every time we SEND a probe `session/cancel`;
    // decremented when its ack is consumed (an `alive-cancelled` inside the
    // probe window, OR a delayed `stop('cancelled')` observed later on the
    // normal message path). A delayed `stop('cancelled')` while this is > 0 is
    // the ack of OUR probe cancel (not a user cancellation), so it must NOT
    // emptyTurn()/silently drop the turn — it is recovered as an alive-cancelled
    // re-prompt. Using an outstanding-count (not a sticky boolean) means the
    // motivating scenario — probe takes the `alive-updated` branch (which does
    // NOT spend the re-prompt budget) and the cancel lands afterwards — remains
    // reachable, and the flag is not permanently sticky after the ack is
    // consumed.
    let outstandingProbeCancels = 0;

    // Baseline of resident descendant pids (MCP servers) captured at
    // prompt start, so the tool-liveness probe can isolate NEW tool children.
    // `sawToolChild` carries across probe ticks whether a new tool child has
    // been observed during the current in-flight tool (a precondition for DEAD).
    const baselinePids = procLivenessEnabled ? captureBaselinePids(this.getPid()) : new Set<number>();
    // Carries sawChild + the consecutive-absent streak across probe
    // ticks (DEAD requires DEAD_ABSENT_STREAK_THRESHOLD consecutive absent
    // ticks, not one). Reset to a fresh state at every tool boundary.
    let toolProbeState = initialToolProbeState();

    // Track open tool ids so a tool-interruption marker can synthesize a
    // terminal result for each dangling toolUse before ending the turn.
    const inFlightToolIds = new Set<string>();

    let fullText = '';

    // Hold exactly ONE outstanding `nextUpdate()` waiter across loop
    // iterations. The race, the cancel probe, and the tool probe all
    // consume THIS shared promise instead of each registering a fresh waiter.
    // When a watchdog branch wins the race the pending promise is NOT cleared,
    // so its single waiter stays first in the ManualSession FIFO and receives
    // the next real message (cancel ack / stop / tool_call) — no abandoned
    // waiter can swallow it. `pendingNext` is cleared only once its message is
    // actually consumed, after which the next iteration registers a fresh one.
    let pendingNext: Promise<ActiveSessionMessage> | undefined;
    const peekNext = (): Promise<ActiveSessionMessage> => (pendingNext ??= session.nextUpdate());

    // Build the final AgentResult for a stop message (or a synthetic end).
    const buildResult = (stopReason: AcpStopReason | 'end_turn'): AgentResult =>
      new AgentResult({
        stopReason: mapStopReason(stopReason as AcpStopReason),
        lastMessage: new Message({ role: 'assistant', content: [new TextBlock(fullText)] }),
        invocationState: {},
      });

    try {
      void session.prompt(args);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const raced = await Promise.race([
          peekNext().then((m) => ({ tag: 'msg' as const, m })),
          watchdog.failure, // hard wall → rejects (always lethal)
          watchdog.idle.then(() => ({ tag: 'idle' as const })),
          watchdog.toolProbe.then(() => ({ tag: 'toolprobe' as const })),
        ]);

        // ---- Tool-liveness probe (fires WHILE a tool is in-flight) ----------
        // The idle watchdog defers while tools are in-flight, so its
        // probe never runs with expectToolChild=true and DEAD was unreachable.
        // This separate probe DOES fire during tool execution, letting the
        // /proc measurement detect a tool child that vanished with no result
        // frame (DEAD) or confirm it is doing real work (ALIVE_ACTIVE → keep
        // waiting). Does NOT touch pendingNext (no message consumed).
        if (raced.tag === 'toolprobe') {
          if (procLivenessEnabled && watchdog.toolsInFlight > 0) {
            // Completion: measure NON-baseline (tool-spawned) descendants
            // and run the pure state machine. DEAD only when we OBSERVED a tool
            // child that then vanished — an in-process MCP tool never sets
            // sawToolChild, so it is never falsely killed.
            const m = await measureNewDescendantActivity(this.getPid(), baselinePids);
            const decision = decideToolProbeVerdict(toolProbeState, m);
            toolProbeState = decision.state;
            if (decision.verdict === 'DEAD') {
              console.warn(
                `[kiro-acp-agent] tool-liveness probe: a tool child that was running has vanished with no ` +
                  `result frame across ${DEAD_ABSENT_STREAK_THRESHOLD} consecutive probes; treating as confirmed ` +
                  `wedge (early death)`
              );
              throw new Error(watchdog.idleErrorMessage());
            }
            // ALIVE / WAIT → keep waiting (idle + hard wall still govern).
          } else if (watchdog.toolsInFlight === 0) {
            // No tool in-flight → a new tool will start fresh; reset the probe
            // state so a prior tool's observation does not leak into the next
            // tool's DEAD decision.
            toolProbeState = initialToolProbeState();
          }
          watchdog.rearmToolProbe();
          continue;
        }

        if (raced.tag === 'idle') {
          // Measurement-based liveness FIRST. If /proc shows an active tool
          // descendant, defer (do NOT kill). DEAD (expected tool child gone) →
          // early wedge. UNKNOWN → fall through to the cancel probe.
          if (procLivenessEnabled) {
            const verdict = await probeSubprocessLiveness(this.getPid(), {
              expectToolChild: watchdog.toolsInFlight > 0,
            });
            if (verdict === 'ALIVE_ACTIVE') {
              console.warn(
                `[kiro-acp-agent] idle watchdog fired but /proc shows an active tool subprocess; ` +
                  `deferring (not killing)`
              );
              watchdog.rearmIdle();
              continue;
            }
            if (verdict === 'DEAD') {
              console.warn(
                `[kiro-acp-agent] idle watchdog fired and /proc shows the in-flight tool child vanished ` +
                  `with no result frame; treating as confirmed wedge (early death)`
              );
              throw new Error(watchdog.idleErrorMessage());
            }
            // UNKNOWN → fall through to the cancel probe below.
          }

          // Idle fired. Decide via a bounded cancel probe whether to recover
          // non-lethally (subprocess alive) or surface a confirmed wedge.
          if (
            !cancelProbeEnabled ||
            cancelProbeRecoveries >= MAX_CANCEL_PROBE_RECOVERIES ||
            options?.cancelSignal?.aborted
          ) {
            throw new Error(watchdog.idleErrorMessage());
          }
          // The probe consumes the SAME shared pending waiter.
          // Record that a probe cancel is now outstanding so a
          // later delayed `stop('cancelled')` on the normal path is attributed
          // to OUR probe (not a user cancellation).
          outstandingProbeCancels++;
          const probe = await this.runCancelProbe(session, cancelAckTimeoutMs, peekNext);
          if (probe.consumed) pendingNext = undefined; // the shared waiter's message was taken
          if (probe.outcome === 'no-ack') {
            // Confirmed wedge — surface as the idle-timeout error (retry-ladder
            // will dispose + respawn + session/load resume). pendingNext is
            // left intact (not consumed) but the throw tears the turn down.
            throw new Error(watchdog.idleErrorMessage());
          }

          if (probe.outcome === 'completed' && probe.stopMessage) {
            // The prompt turn actually FINISHED during the probe window
            // (agent was slow, not wedged). Return it as the turn result — do
            // NOT re-prompt (that would re-run a completed turn / double side
            // effects).
            const result = buildResult(probe.stopMessage.stopReason);
            yield { type: 'result', result };
            return result;
          }

          if (probe.outcome === 'alive-updated' && probe.pending) {
            // A real update arrived during the probe window. Route it
            // through the SAME processing as the normal path (bookkeeping +
            // marker detection), so e.g. a probe-delivered interruption
            // marker still ends the turn cleanly.
            //
            // This is NOT a re-prompt, so it does NOT spend the
            // re-prompt budget (cancelProbeRecoveries). The probe cancel we
            // sent stays OUTSTANDING — its ack (a delayed `stop('cancelled')`)
            // is expected on the normal path and handled by the ack-attribution branch,
            // which now remains reachable.
            console.warn(
              `[kiro-acp-agent] idle watchdog fired but subprocess is alive ` +
                `(alive-updated); consuming pending update, probe cancel still outstanding`
            );
            watchdog.rearmIdle();
            const outcome = yield* this.processMessageUpdate(probe.pending, watchdog, inFlightToolIds, (t) => {
              fullText += t;
            });
            // Tool-boundary reset (see the normal-path comment).
            if (watchdog.toolsInFlight === 0) toolProbeState = initialToolProbeState();
            if (outcome.interrupted) {
              const result = buildResult('end_turn');
              yield { type: 'result', result };
              return result;
            }
            continue;
          }

          // alive-cancelled: the in-flight prompt was aborted by our probe
          // cancel and the ack was consumed inside the probe window. Recover by
          // resetting + re-prompting the SAME session — UNLESS the re-prompt
          // budget is exhausted or the loop vetoes (double-execution guard: the aborted attempt
          // already ran tools, so re-prompting would re-execute side effects;
          // the loop returns false and we surface a wedge → ladder giveup →
          // auto-retrigger).
          outstandingProbeCancels = Math.max(0, outstandingProbeCancels - 1); // ack consumed
          if (cancelProbeRecoveries >= MAX_CANCEL_PROBE_RECOVERIES || !canReprompt()) {
            console.warn(
              `[kiro-acp-agent] cancel-probe recovery declined ` +
                `(recoveries=${cancelProbeRecoveries}/${MAX_CANCEL_PROBE_RECOVERIES}, canReprompt=${canReprompt()}); ` +
                `surfacing wedge for cross-turn auto-retrigger`
            );
            throw new Error(watchdog.idleErrorMessage());
          }
          cancelProbeRecoveries++;
          console.warn(
            `[kiro-acp-agent] idle watchdog fired but subprocess is alive ` +
              `(alive-cancelled); non-lethal recovery #${cancelProbeRecoveries}: re-prompting same session`
          );
          yield* this.repromptSameSession(session, args, watchdog, inFlightToolIds, () => {
            fullText = '';
          });
          continue;
        }

        // ---- normal message path (raced.tag === 'msg') ----------------------
        const msg = raced.m;
        pendingNext = undefined; // consumed → next iteration registers a fresh waiter
        if (msg.kind === 'stop') {
          // A delayed `stop('cancelled')` while a probe cancel
          // is OUTSTANDING is the ack of OUR probe (not a user abort). It must
          // NOT end the turn as empty. Attribution is `outstandingProbeCancels
          // > 0`, INDEPENDENT of the re-prompt budget — so this branch stays
          // reachable even after the probe took the alive-updated path (which
          // does not spend the budget). We consume the ack (decrement) here
          // regardless of whether we go on to re-prompt.
          if (
            msg.stopReason === 'cancelled' &&
            outstandingProbeCancels > 0 &&
            !options?.cancelSignal?.aborted &&
            cancelProbeEnabled
          ) {
            outstandingProbeCancels = Math.max(0, outstandingProbeCancels - 1); // ack consumed
            // canReprompt() reads toolActivityThisAttempt, which the
            // loop now flags synchronously at tool_call dispatch — so a
            // tool_call immediately followed by this delayed ack is correctly
            // seen as "tools already ran" and we decline the re-prompt.
            if (cancelProbeRecoveries >= MAX_CANCEL_PROBE_RECOVERIES || !canReprompt()) {
              console.warn(
                `[kiro-acp-agent] delayed probe-cancel ack; recovery declined ` +
                  `(recoveries=${cancelProbeRecoveries}/${MAX_CANCEL_PROBE_RECOVERIES}, canReprompt=${canReprompt()}); ` +
                  `surfacing wedge for cross-turn auto-retrigger`
              );
              throw new Error(watchdog.idleErrorMessage());
            }
            cancelProbeRecoveries++;
            console.warn(
              `[kiro-acp-agent] delayed probe-cancel ack observed on normal path; ` +
                `non-lethal recovery #${cancelProbeRecoveries}: re-prompting same session`
            );
            yield* this.repromptSameSession(session, args, watchdog, inFlightToolIds, () => {
              fullText = '';
            });
            continue;
          }
          const result = buildResult(msg.stopReason);
          yield { type: 'result', result };
          return result;
        }
        const outcome = yield* this.processMessageUpdate(msg.update, watchdog, inFlightToolIds, (t) => {
          fullText += t;
        });
        // Reset the tool-probe state at the TOOL BOUNDARY (every
        // message once no tool is in-flight), not only on a 60s probe tick.
        // Otherwise a child-spawning tool (e.g. execute_bash) sets sawChild,
        // completes, and a following in-process tool (resident MCP, spawns no
        // child) inherits the stale state → the next tool-liveness tick sees "no
        // new descendant + sawChild" → false DEAD kills a healthy in-process
        // tool. Evaluating on the ms-granular message stream closes that window.
        if (watchdog.toolsInFlight === 0) toolProbeState = initialToolProbeState();
        if (outcome.interrupted) {
          const result = buildResult('end_turn');
          yield { type: 'result', result };
          return result;
        }
      }
    } finally {
      watchdog.cleanup();
      if (options?.cancelSignal) options.cancelSignal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Process one `session/update` on the shared streaming path: emit its events
   * (updating fullText via `appendText` + the in-flight tool-id set), and if it
   * is the tool-interruption marker, synthesize terminal `failed` results
   * for every dangling tool and report `interrupted: true` so the caller ends
   * the turn cleanly. Used by BOTH the normal race branch and the
   * alive-updated recovery branch so neither can skip marker
   * detection or tool bookkeeping.
   */
  private *processMessageUpdate(
    u: SessionUpdate,
    watchdog: WatchdogController,
    inFlightToolIds: Set<string>,
    appendText: (t: string) => void
  ): Generator<KiroAgentStreamEvent, { interrupted: boolean }, undefined> {
    // S2: a chunk that is EXACTLY the tool-interruption marker is kiro-cli's
    // internal control sentence, not model output — suppress its text-delta so
    // it never surfaces to the user as an assistant message, and end the turn.
    if (
      u.sessionUpdate === 'agent_message_chunk' &&
      u.content.type === 'text' &&
      isToolInterruptedMarker(u.content.text)
    ) {
      watchdog.onEvent();
      console.warn(
        `[kiro-acp-agent] detected tool-interruption marker; synthesizing terminal results for ` +
          `${inFlightToolIds.size} in-flight tool(s) and ending the turn cleanly (marker text suppressed)`
      );
      for (const ev of buildInterruptedToolResults(inFlightToolIds)) {
        if (ev.type === 'tool-result') watchdog.resolveToolStatus(ev.toolCallId, ev.status);
        yield ev;
      }
      inFlightToolIds.clear();
      return { interrupted: true };
    }

    for (const ev of this.emitUpdate(u, watchdog)) {
      if (ev.type === 'text-delta') appendText(ev.text);
      if (ev.type === 'tool-call') inFlightToolIds.add(ev.toolCallId);
      if (ev.type === 'tool-result' && watchdog.terminalToolStatuses.has(ev.status)) {
        inFlightToolIds.delete(ev.toolCallId);
      }
      yield ev;
    }
    return { interrupted: false };
  }

  /**
   * Alive-cancelled recovery: reset the aborted attempt's partial state and
   * re-prompt the SAME live session. Emits a `reset` event so the consumer
   * (promptCompat / the loop fan-out) drops its own accumulation too, then
   * re-issues the prompt. `clearFullText` resets the caller's stream-local text.
   *
   * NOTE (context-bloat tradeoff): under process reuse the cancelled prompt
   * is already in kiro-cli's own session history and this re-prompt adds another
   * user turn. Accepted: cancellations are far rarer than clean turns, recovery
   * is bounded to MAX_CANCEL_PROBE_RECOVERIES per stream, and the alternative
   * (respawn + session/load) is more expensive.
   *
   * NOTE: ManualSession.prompt() clears its queue, so any update that arrived
   * between the cancel ack and this re-prompt is intentionally discarded (it
   * belonged to the aborted attempt).
   */
  private *repromptSameSession(
    session: SessionLike,
    args: KiroAcpPromptInput,
    watchdog: WatchdogController,
    inFlightToolIds: Set<string>,
    clearFullText: () => void
  ): Generator<KiroAgentStreamEvent, void, undefined> {
    clearFullText();
    inFlightToolIds.clear();
    yield { type: 'reset' };
    watchdog.rearmIdle();
    void session.prompt(args);
  }

  /**
   * Translate one ACP `session/update` into zero or more
   * {@link KiroAgentStreamEvent}s and feed the watchdog. Pure w.r.t. the
   * stream generator (returns an array the caller yields), so it can be reused
   * both on the normal update path and on the cancel-probe recovery path
   * without duplicating the switch.
   */
  private emitUpdate(u: SessionUpdate, watchdog: WatchdogController): KiroAgentStreamEvent[] {
    const out: KiroAgentStreamEvent[] = [];
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        watchdog.onEvent();
        if (u.content.type === 'text') out.push({ type: 'text-delta', text: u.content.text });
        break;
      case 'agent_thought_chunk':
        if (u.content.type === 'text') out.push({ type: 'thinking-delta', text: u.content.text });
        break;
      case 'tool_call':
        watchdog.onEvent();
        if (u.toolCallId) watchdog.addToolInFlight(u.toolCallId);
        out.push({
          type: 'tool-call',
          toolCallId: u.toolCallId,
          name: u.name ?? u.title,
          title: u.title,
          kind: u.kind,
          rawInput: u.rawInput,
        });
        break;
      case 'tool_call_update': {
        watchdog.onEvent();
        const status = u.status ?? '';
        if (u.toolCallId) watchdog.resolveToolStatus(u.toolCallId, status);
        out.push({
          type: 'tool-result',
          toolCallId: u.toolCallId,
          status,
          title: u.title ?? '',
          output: extractToolOutput(u),
          rawOutput: (u as { rawOutput?: unknown }).rawOutput,
        });
        break;
      }
      case 'usage_update': {
        const used = u.used;
        const size = u.size;
        out.push({ type: 'usage', used, size, percentage: size > 0 ? (used / size) * 100 : 0 });
        break;
      }
      default:
        break;
    }
    return out;
  }

  /**
   * Cancel probe: send `session/cancel` and wait a bounded time for kiro-cli
   * to prove it is alive. Outcomes: `alive-cancelled` (cancel acked),
   * `completed` (turn actually finished during the window), `alive-updated`
   * (real progress arrived), `no-ack` (confirmed wedge).
   *
   * The probe consumes the SAME pending next-message promise the stream
   * loop holds (via `peekNext`) instead of registering a fresh
   * `session.nextUpdate()` waiter. A cancel ack (or any message) therefore
   * resolves the single outstanding waiter and is delivered to the probe, not
   * to an abandoned race waiter. `consumed` tells the caller whether the shared
   * pending was resolved (so it can clear it); on `no-ack` the pending is left
   * intact for the next iteration to consume.
   *
   * The decision from a settled message is delegated to the pure
   * {@link interpretCancelProbeMessage} so the policy is unit-tested directly.
   */
  private async runCancelProbe(
    session: SessionLike,
    timeoutMs: number,
    peekNext: () => Promise<ActiveSessionMessage>
  ): Promise<{
    outcome: 'alive-cancelled' | 'completed' | 'alive-updated' | 'no-ack';
    consumed: boolean;
    pending?: SessionUpdate;
    stopMessage?: ActiveSessionMessage & { kind: 'stop' };
  }> {
    const ctx = this.ctx;
    if (ctx) {
      try {
        await ctx.notify('session/cancel', { sessionId: session.sessionId });
      } catch (e) {
        console.warn(
          `[kiro-acp-agent] cancel probe: session/cancel notify failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    const TIMED_OUT = Symbol('cancel-probe-timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      const raced = await Promise.race([peekNext(), timeout]);
      if (raced === TIMED_OUT) return { outcome: 'no-ack', consumed: false };
      const interpreted = interpretCancelProbeMessage(raced);
      return { ...interpreted, consumed: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Consume stream() and return only the final AgentResult. */
  async invoke(args: KiroAcpPromptInput, options?: { cancelSignal?: AbortSignal }): Promise<AgentResult> {
    const it = this.stream(args, options);
    let next = await it.next();
    while (!next.done) next = await it.next();
    return next.value;
  }

  /**
   * `prompt`-compatible adapter: consume `stream()` and translate
   * `KiroAgentStreamEvent`s into the legacy `(onChunk, onEvent)` callback shape
   * + `KiroPromptResult` return, so the shared kiro fan-out logic (discard /
   * normalize / redelivery / persist) can drive this agent through the exact
   * same interface that was defined by the former hand-written client. This is
   * the seam that lets `kiroAcpSdkAgentLoop` reuse the existing fan-out with no
   * behavioural drift.
   *
   * NOTE: `text` in the returned result is the FULL concatenated agent text
   * (matching the `KiroPromptResult.text` contract), so
   * the loop's tool-boundary discard subtraction stays aligned.
   */
  async promptCompat(
    input: KiroAcpPromptInput,
    onChunk?: (text: string) => void,
    onToolEvent?: (event: KiroToolCallEvent) => void,
    options?: { cancelSignal?: AbortSignal; onReset?: () => void; canReprompt?: () => boolean }
  ): Promise<KiroPromptResult> {
    let fullText = '';
    const toolCalls: KiroToolCall[] = [];
    let stopReason = 'end_turn';

    const it = this.stream(input, { cancelSignal: options?.cancelSignal, canReprompt: options?.canReprompt });
    let next = await it.next();
    while (!next.done) {
      const ev = next.value;
      switch (ev.type) {
        case 'reset':
          // An alive-cancelled re-prompt is about to stream the turn
          // again on the same session. Drop everything the aborted attempt
          // accumulated here AND notify the loop so its fan-out (flushState /
          // in-flight tool bookkeeping) resets too — otherwise the pre-cancel
          // text/tools would be double-counted.
          fullText = '';
          toolCalls.length = 0;
          options?.onReset?.();
          break;
        case 'text-delta':
          fullText += ev.text;
          onChunk?.(ev.text);
          break;
        case 'tool-call': {
          const toolCall: KiroToolCall = {
            toolCallId: ev.toolCallId,
            title: ev.title,
            kind: ev.kind ?? '',
            rawInput: (ev.rawInput as Record<string, unknown> | undefined) ?? undefined,
          };
          toolCalls.push(toolCall);
          onToolEvent?.({ type: 'tool_call', toolCall });
          break;
        }
        case 'tool-result':
          onToolEvent?.({
            type: 'tool_call_update',
            toolCallId: ev.toolCallId,
            status: ev.status,
            title: ev.title,
            output: ev.output,
          });
          break;
        default:
          break;
      }
      next = await it.next();
    }
    // next.value is the final AgentResult carrying the mapped Strands
    // stopReason. Collapse back to the ACP-style string the loop consumes.
    // NOTE (parity caveat): only 'cancelled' and 'maxTokens' are distinguished;
    // every other Strands stopReason — including 'refusal' and the limit* family
    // ('limitTurns'/'limitTotalTokens'/'limitOutputTokens', which map from ACP
    // 'max_turn_requests') — is collapsed to 'end_turn' here. The legacy loop
    // only branches on 'cancelled' vs everything-else for delivery, so this is
    // behaviourally equivalent on the current consumer, but if a future consumer
    // needs to distinguish refusal/limit stops this collapse must be revisited.
    const finalStop = next.value.stopReason;
    stopReason = finalStop === 'cancelled' ? 'cancelled' : finalStop === 'maxTokens' ? 'max_tokens' : 'end_turn';

    return {
      stopReason,
      text: fullText,
      toolCalls,
      contextUsagePercentage: this.latestUsage?.percentage,
    };
  }

  getLatestContextUsage(): { used: number; size: number; percentage: number } | undefined {
    return this.latestUsage;
  }

  getPid(): number | undefined {
    return this.handle?.proc.pid;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.session?.dispose();
    this.closeConnection?.();
    // Bound every await in dispose(). A wedged kiro-cli whose stream
    // never closes would otherwise hang connectionDone / exited FOREVER, and
    // since S3 made finalizeAgent dispose unconditionally, that hang would
    // stall the whole turn's finalize. We wait a bounded time for a graceful
    // teardown, then fall through to kill() and a bounded wait on exit; if the
    // process still has not reaped we give up waiting (the SIGKILL has been
    // sent — the OS will reap it; we must not block the turn on it).
    const graceMs = disposeGraceMs();
    if (this.connectionDone) {
      await settleWithin(this.connectionDone, graceMs).catch(() => {
        // teardown errors / timeout are non-fatal — proceed to kill
      });
    }
    this.handle?.kill();
    if (this.handle) {
      await settleWithin(this.handle.exited, graceMs).catch(() => {
        // exit-wait timeout is non-fatal: SIGKILL was sent, do not block the turn
      });
    }
  }
}
