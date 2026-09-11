/**
 * proc-liveness — measurement-based liveness for the kiro-cli subprocess tree.
 * ===========================================================================
 * Before the idle/hard-wall watchdogs treat a silent turn as dead, we can
 * MEASURE what the subprocess is actually doing via the Linux `/proc`
 * filesystem (AgentCore runs Linux). A tool the model launched (a build, a
 * `sleep`, a long `git clone`) shows up as a DESCENDANT process of the kiro-cli
 * subprocess. If any descendant is currently running / uninterruptible-sleep
 * (state R/D) or is burning CPU (utime+stime advancing across two samples), the
 * turn is NOT hung — it is doing real work, so the watchdog must NOT kill it.
 *
 * Conversely, when a tool child that we KNOW is in flight (the agent emitted a
 * `tool_call` but no terminal `tool_call_update`) has vanished from the process
 * table, that tool died without a result frame — an early, positive death
 * signal we can act on before the full idle timeout.
 *
 * FAIL-SAFE CONTRACT (critical): this probe must NEVER cause a kill on its own
 * uncertainty. Any inability to measure (/proc absent on non-Linux or a
 * restricted container, a read error, a race where the tree is empty) yields
 * `UNKNOWN`, and the caller falls back to the existing timer-based behaviour
 * (the cancel probe, then the watchdog). A probe error is swallowed to
 * UNKNOWN — it is never allowed to escalate to DEAD.
 *
 * Pure + fully dependency-injectable (readStat / listPids / sleep) so the
 * classification logic is unit-tested against real code without touching the
 * host `/proc`.
 */
import { readFileSync } from 'fs';
import { readdirSync } from 'fs';
import { parseBoolEnvDefaultOn } from './env-parse';

export type LivenessVerdict = 'ALIVE_ACTIVE' | 'DEAD' | 'UNKNOWN';

/** Parsed subset of `/proc/<pid>/stat` fields this probe consumes. */
export interface ProcStat {
  pid: number;
  ppid: number;
  /** Process state char: R (running), D (uninterruptible), S (sleep), Z, etc. */
  state: string;
  /** utime + stime in clock ticks (CPU consumed). */
  cpuTicks: number;
}

export interface ProcLivenessDeps {
  /** Return raw `/proc/<pid>/stat` contents, or undefined if unreadable/gone. */
  readStat: (pid: number) => string | undefined;
  /** List all numeric pids currently present under `/proc`. */
  listPids: () => number[];
  /** Sleep between the two CPU samples. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * Parse the fields of a `/proc/<pid>/stat` line. `comm` (field 2) is wrapped in
 * parentheses and may contain spaces/parentheses, so we parse from the LAST
 * `)` to avoid miscounting. Post-`comm` token indices (0-based):
 *   state=0, ppid=1, utime=11, stime=12, starttime=19.
 * Returns undefined when the line is malformed.
 *
 * Exported for unit testing.
 */
export function parseProcStat(pid: number, raw: string): ProcStat | undefined {
  const rparen = raw.lastIndexOf(')');
  if (rparen < 0) return undefined;
  const rest = raw
    .slice(rparen + 1)
    .trim()
    .split(/\s+/);
  const state = rest[0];
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!state || !Number.isFinite(ppid) || !Number.isFinite(utime) || !Number.isFinite(stime)) {
    return undefined;
  }
  return { pid, ppid, state, cpuTicks: utime + stime };
}

/**
 * Collect the descendant pids of `rootPid` (children, grandchildren, ...) from
 * a snapshot of every readable `/proc/<pid>/stat`. `rootPid` itself is NOT
 * included. Returns the descendants' parsed stats.
 *
 * Exported for unit testing.
 */
export function collectDescendants(rootPid: number, deps: Pick<ProcLivenessDeps, 'readStat' | 'listPids'>): ProcStat[] {
  const all = new Map<number, ProcStat>();
  for (const pid of deps.listPids()) {
    const raw = deps.readStat(pid);
    if (!raw) continue;
    const stat = parseProcStat(pid, raw);
    if (stat) all.set(pid, stat);
  }
  // Build child adjacency and BFS from rootPid.
  const childrenOf = new Map<number, number[]>();
  for (const stat of all.values()) {
    const list = childrenOf.get(stat.ppid);
    if (list) list.push(stat.pid);
    else childrenOf.set(stat.ppid, [stat.pid]);
  }
  const descendants: ProcStat[] = [];
  const queue = [...(childrenOf.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const stat = all.get(pid);
    if (stat) descendants.push(stat);
    for (const c of childrenOf.get(pid) ?? []) queue.push(c);
  }
  return descendants;
}

/** True when any descendant is in a running / uninterruptible state (R or D). */
const anyRunning = (stats: ProcStat[]): boolean => stats.some((s) => s.state === 'R' || s.state === 'D');

/**
 * Minimum total descendant CPU advance (in clock ticks) between the two
 * samples to count as ALIVE_ACTIVE on the CPU-delta path. A long-lived stdio
 * MCP server sitting in its event loop wakes briefly on timer/epoll ticks and
 * can accrue 1 tick of CPU across a 200ms window without doing any real tool
 * work; requiring a delta strictly greater than this threshold prevents such
 * resident-server noise from masquerading as an active tool (a false
 * ALIVE_ACTIVE that would wrongly defer the watchdog forever). A genuinely
 * working tool burns far more than 1 tick in 200ms. R/D state is still an
 * immediate ALIVE_ACTIVE signal regardless of this threshold.
 */
const CPU_DELTA_MIN_TICKS = 1;

/**
 * Classify subprocess-tree liveness for the idle watchdog.
 *
 * Verdicts:
 *   - `ALIVE_ACTIVE`: at least one descendant is running (R/D) at either
 *     sample, OR total descendant CPU advanced between the two samples → a tool
 *     is doing real work → DO NOT kill.
 *   - `DEAD`: we were told a tool is in flight (`expectToolChild=true`) but the
 *     descendant tree is empty at BOTH samples → the tool child vanished with
 *     no result frame → an early death signal.
 *   - `UNKNOWN`: cannot decide safely — `/proc` unreadable (no descendants read
 *     AND rootPid itself unreadable), no expected tool child, or descendants
 *     exist but are idle (S) with no CPU movement (kiro-cli itself waiting).
 *     The caller falls back to the timer/cancel-probe path. NEVER escalate to
 *     DEAD from uncertainty.
 *
 * Fail-safe: any thrown error inside is caught by {@link probeSubprocessLiveness}
 * and mapped to UNKNOWN.
 *
 * Pure. Exported for unit testing.
 */
export function classifyLiveness(
  sample1: ProcStat[],
  sample2: ProcStat[],
  opts: { expectToolChild: boolean; rootReadable: boolean }
): LivenessVerdict {
  if (anyRunning(sample1) || anyRunning(sample2)) return 'ALIVE_ACTIVE';

  // Require the CPU advance to EXCEED a small threshold, not merely be > 0,
  // so a resident stdio MCP server's idle event-loop tick does not read as an
  // active tool (false ALIVE_ACTIVE).
  const cpu1 = sample1.reduce((a, s) => a + s.cpuTicks, 0);
  const cpu2 = sample2.reduce((a, s) => a + s.cpuTicks, 0);
  if (sample2.length > 0 && cpu2 - cpu1 > CPU_DELTA_MIN_TICKS) return 'ALIVE_ACTIVE';

  // No running descendants and no CPU movement.
  if (opts.expectToolChild && sample1.length === 0 && sample2.length === 0) {
    // A tool child was expected but the tree is empty at both samples: the tool
    // process vanished without emitting a terminal result → early death.
    // Only trust this when we could actually read /proc (rootReadable), so a
    // fully-unreadable /proc does not masquerade as DEAD.
    return opts.rootReadable ? 'DEAD' : 'UNKNOWN';
  }

  return 'UNKNOWN';
}

const CPU_SAMPLE_GAP_MS = 200;

const defaultReadStat = (pid: number): string | undefined => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
};

const defaultListPids = (): number[] => {
  try {
    const out: number[] = [];
    for (const name of readdirSync('/proc')) {
      if (/^\d+$/.test(name)) out.push(Number(name));
    }
    return out;
  } catch {
    return [];
  }
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Measurement of NEW (non-baseline) descendants only.
 *
 * The plain {@link probeSubprocessLiveness} DEAD verdict is effectively
 * unreachable in the production default configuration: resident stdio MCP
 * servers are permanent children of the kiro-cli subprocess, so the descendant
 * tree is NEVER empty and the "empty at both samples" DEAD condition never
 * holds. Worse, an OS-level "tool child vanished" cannot be distinguished from
 * an MCP tool that runs IN-PROCESS inside a resident server (no new child ever
 * spawns) using /proc alone — so naively flagging "no tool child" as DEAD would
 * false-positive on every MCP tool call and kill live turns.
 *
 * The reachable-and-safe design records a BASELINE set of descendant pids at
 * prompt start (the resident MCP servers spawned during session setup). During
 * a tool-in-flight probe we look ONLY at descendants NOT in the baseline (i.e.
 * genuinely new children spawned by the tool, such as execute_bash → sh → …).
 * DEAD is then decided by the caller's small state machine
 * ({@link decideToolProbeVerdict}): we only conclude DEAD once we have OBSERVED
 * a new tool child and it has subsequently vanished while the tool is still
 * in-flight. A tool that never spawns an OS child (pure MCP in-process work)
 * never registers a child, so it is never flagged DEAD — it stays a WAIT and is
 * left to the idle/hard-wall timers.
 */
export interface NewDescendantMeasurement {
  /** At least one non-baseline descendant is present (in either sample). */
  present: boolean;
  /** A non-baseline descendant is running (R/D) or advanced CPU beyond the tick threshold. */
  active: boolean;
  /** Whether `/proc` for the root was readable (fail-safe gate). */
  rootReadable: boolean;
}

const filterNew = (stats: ProcStat[], baseline: ReadonlySet<number>): ProcStat[] =>
  stats.filter((s) => !baseline.has(s.pid));

/**
 * Take two `/proc` samples and report presence/activity of NEW (non-baseline)
 * descendants of `rootPid`. Any error → a safe reading
 * (`{present:false, active:false, rootReadable:false}`) so the caller never
 * escalates to DEAD on a measurement failure. Deps injectable for tests.
 */
export async function measureNewDescendantActivity(
  rootPid: number | undefined,
  baselinePids: ReadonlySet<number>,
  deps: Partial<ProcLivenessDeps> = {}
): Promise<NewDescendantMeasurement> {
  if (rootPid === undefined || !Number.isFinite(rootPid) || rootPid <= 0) {
    return { present: false, active: false, rootReadable: false };
  }
  const readStat = deps.readStat ?? defaultReadStat;
  const listPids = deps.listPids ?? defaultListPids;
  const sleep = deps.sleep ?? defaultSleep;
  try {
    const rootReadable = readStat(rootPid) !== undefined;
    const s1 = filterNew(collectDescendants(rootPid, { readStat, listPids }), baselinePids);
    await sleep(CPU_SAMPLE_GAP_MS);
    const s2 = filterNew(collectDescendants(rootPid, { readStat, listPids }), baselinePids);
    const present = s1.length > 0 || s2.length > 0;
    const cpu1 = s1.reduce((a, s) => a + s.cpuTicks, 0);
    const cpu2 = s2.reduce((a, s) => a + s.cpuTicks, 0);
    const active = anyRunning(s1) || anyRunning(s2) || (s2.length > 0 && cpu2 - cpu1 > CPU_DELTA_MIN_TICKS);
    return { present, active, rootReadable };
  } catch {
    return { present: false, active: false, rootReadable: false };
  }
}

/** Verdict of the tool-liveness state machine ({@link decideToolProbeVerdict}). */
export type ToolProbeVerdict = 'ALIVE' | 'DEAD' | 'WAIT';

/**
 * Carried state for the tool-liveness state machine across probe ticks.
 *  - `sawChild`: have we EVER observed a new (non-baseline) tool descendant
 *    during the current in-flight tool.
 *  - `absentStreak`: how many CONSECUTIVE ticks the child has been absent AFTER
 *    it was first observed (debounce counter).
 */
export interface ToolProbeState {
  sawChild: boolean;
  absentStreak: number;
}

/** Fresh state at a tool boundary (no child seen yet). */
export const initialToolProbeState = (): ToolProbeState => ({ sawChild: false, absentStreak: 0 });

/**
 * Number of CONSECUTIVE absent observations (after a child was seen) required
 * before declaring DEAD. A single absent tick races the normal
 * child-exit→result-frame delivery window (a child that finished cleanly can be
 * gone from /proc for a tick or two before its result frame lands, and resident
 * MCP CPU is baseline-excluded so invisible). Requiring TWO consecutive absent
 * ticks turns that transient into a WAIT and only escalates a genuinely
 * vanished child to DEAD (detection latency grows by one probe interval, an
 * acceptable trade for eliminating the false-DEAD race).
 */
export const DEAD_ABSENT_STREAK_THRESHOLD = 2;

/**
 * Pure state machine for the tool-in-flight liveness probe (baseline
 * exclusion + absent-tick debounce).
 *
 *  - active new descendant            → ALIVE (real work; keep waiting), reset streak
 *  - present-but-idle new descendant  → WAIT  (e.g. blocked on IO), reset streak
 *  - absent, saw one before           → increment absentStreak; DEAD only once
 *                                        it reaches DEAD_ABSENT_STREAK_THRESHOLD
 *                                        consecutive absent ticks, else WAIT
 *  - absent, never saw one            → WAIT  (MCP in-process tool / not spawned yet)
 *
 * A measurement with `rootReadable=false` is "cannot measure" → WAIT, streak
 * reset, sawChild preserved (fail-safe: an unreadable /proc tick must neither
 * DEAD nor advance the DEAD countdown). Exported for unit testing.
 */
export function decideToolProbeVerdict(
  prev: ToolProbeState,
  m: NewDescendantMeasurement
): { verdict: ToolProbeVerdict; state: ToolProbeState } {
  if (!m.rootReadable) return { verdict: 'WAIT', state: { sawChild: prev.sawChild, absentStreak: 0 } };
  if (m.active) return { verdict: 'ALIVE', state: { sawChild: true, absentStreak: 0 } };
  if (m.present) return { verdict: 'WAIT', state: { sawChild: true, absentStreak: 0 } };
  if (prev.sawChild) {
    const absentStreak = prev.absentStreak + 1;
    if (absentStreak >= DEAD_ABSENT_STREAK_THRESHOLD) {
      return { verdict: 'DEAD', state: { sawChild: true, absentStreak } };
    }
    return { verdict: 'WAIT', state: { sawChild: true, absentStreak } };
  }
  return { verdict: 'WAIT', state: { sawChild: false, absentStreak: 0 } };
}

/**
 * Capture the current descendant pids of `rootPid` as a baseline (resident MCP
 * servers etc.) so later probes can isolate NEW tool children. Single sample,
 * synchronous. Errors → empty set (a tool child then simply looks "new", the
 * safe direction for ALIVE detection). Deps injectable for tests.
 */
export function captureBaselinePids(
  rootPid: number | undefined,
  deps: Pick<ProcLivenessDeps, 'readStat' | 'listPids'> = {
    readStat: defaultReadStat,
    listPids: defaultListPids,
  }
): Set<number> {
  const out = new Set<number>();
  if (rootPid === undefined || !Number.isFinite(rootPid) || rootPid <= 0) return out;
  try {
    for (const s of collectDescendants(rootPid, deps)) out.add(s.pid);
  } catch {
    /* empty baseline on error (safe direction) */
  }
  return out;
}

/**
 * Measure liveness of the kiro-cli subprocess tree rooted at `rootPid` by
 * taking two `/proc` samples `CPU_SAMPLE_GAP_MS` apart. Returns a
 * {@link LivenessVerdict}. Any error → UNKNOWN (fail-safe: never kills on its
 * own uncertainty). Deps are injectable for tests.
 */
export async function probeSubprocessLiveness(
  rootPid: number | undefined,
  opts: { expectToolChild: boolean },
  deps: Partial<ProcLivenessDeps> = {}
): Promise<LivenessVerdict> {
  if (rootPid === undefined || !Number.isFinite(rootPid) || rootPid <= 0) return 'UNKNOWN';
  const readStat = deps.readStat ?? defaultReadStat;
  const listPids = deps.listPids ?? defaultListPids;
  const sleep = deps.sleep ?? defaultSleep;
  try {
    const rootReadable = readStat(rootPid) !== undefined;
    const sample1 = collectDescendants(rootPid, { readStat, listPids });
    await sleep(CPU_SAMPLE_GAP_MS);
    const sample2 = collectDescendants(rootPid, { readStat, listPids });
    return classifyLiveness(sample1, sample2, { expectToolChild: opts.expectToolChild, rootReadable });
  } catch {
    // Fail-safe: any measurement error degrades to UNKNOWN — never DEAD.
    return 'UNKNOWN';
  }
}

/** Whether the measurement-based liveness probe is enabled (default ON). */
export const kiroProcLivenessEnabled = (): boolean => parseBoolEnvDefaultOn('KIRO_ACP_PROC_LIVENESS');
