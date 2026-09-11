/**
 * kiro-agent-pool — turn-to-turn reuse of the kiro-cli subprocess.
 * =====================================================================
 * The worker is a long-lived process (agent-core.ts runs a persistent express
 * server; entry.ts main() is guarded by an `isStarted` flag and drives every
 * turn through the same event-bus subscription — so module-level state
 * survives across turns while the container is warm). The kill-timer evicts
 * the whole worker after 30 min idle, which naturally bounds reuse.
 *
 * Historically the SDK loop spawned a fresh `kiro-cli acp` subprocess EVERY
 * turn (spawn → MCP server re-init → DDB→store synthesis → session/load →
 * dispose). That per-turn churn is the leading suspected cause of the bursty
 * `-32603` failures. This pool keeps ONE live {@link KiroAcpAgent} across turns
 * so the next turn can prompt the same in-memory ACP session directly; the
 * synth+load path is demoted to a recovery path used only when the process is
 * dead / absent / configuration-incompatible.
 *
 * FAIL-SAFE: reuse is a kill-switchable optimisation
 * ({@link kiroProcessReuseEnabled}, default ON). Every "can I reuse?" check
 * that is not a clean match disposes the cached agent and falls back to the
 * cold path, so a stale/dead/mismatched process is never handed to a turn.
 *
 * REUSE KEY includes the rewind fingerprint AND the full MCP/config/apiKey/cwd
 * signature: after a webapp rewind (or undo), or a change to any of those, the
 * reused process's in-memory conversation / configuration is stale, and a key
 * mismatch forces a recycle → cold synth+load path. (See applyRewindFilter in
 * agent-core, and {@link buildReuseKey} for the exact fingerprint.)
 *
 * API: the loop drives the pool exclusively through
 * {@link KiroAgentPool.store}, {@link KiroAgentPool.tryAcquire} and
 * {@link KiroAgentPool.clear}. There is intentionally NO `release()` /
 * per-entry release-reason state: the loop's `finalizeAgent` already maps a
 * clean completion to `store` and every other outcome (cancel / error / dead /
 * reuse-disabled) to `clear`, so a cancelled turn leaves NO cached entry and
 * the next turn cold-starts — the "avoid the -32603 reuse race after a cancel"
 * guarantee is a consequence of clear-on-cancel, not a per-entry flag.
 *
 * The pool is a class (injectable clock) exported for unit testing, plus a
 * module-level singleton {@link kiroAgentPool} used by the loop.
 */
import { createHash } from 'node:crypto';
import { parseMsEnv, parseBoolEnvDefaultOn } from './env-parse';

/** Minimal agent surface the pool needs — lets tests inject a fake. */
export interface PoolableAgent {
  isAlive(): boolean;
  dispose(): Promise<void>;
  readonly createdAt: number;
}

/** Inputs that must all match for a cached agent to be reused. */
export interface ReuseKeyInput {
  workerId: string;
  /** The kiro sessionId the cached process loaded (persisted DDB id). */
  sessionId: string | undefined;
  /** Resolved kiro model (undefined = auto). */
  model: string | undefined;
  /** v3 agent mode / --agent name. */
  agentName: string | undefined;
  /**
   * FULL MCP server configuration exposed to the session. The reused
   * process registered these servers at start; a webapp `updateAgent` that
   * keeps the same server name but changes command/args/env/url/headers would
   * otherwise not reach the reused process until max-age. Hashing the complete
   * config (not just type:name) forces a recycle when any field changes.
   */
  mcpServers: unknown;
  /**
   * The Kiro API key in effect for the turn. The reused subprocess was
   * spawned with a specific key; reusing it across a key change would bill a
   * different account / user (multi-user cross-over). Hashed, never stored raw.
   */
  apiKey: string | undefined;
  /** The working directory the subprocess was spawned in. */
  cwd: string | undefined;
  /** Rewind fingerprint: changes on rewind apply/undo. */
  rewindState: { cutoffSK: string; rewindedAt: number } | undefined;
}

/**
 * Deterministic canonical JSON: object keys are emitted in sorted order at
 * every depth so two structurally-equal values with different key insertion
 * order serialise identically. Arrays keep their order (see canonicalizeMcp for
 * the array-order handling specific to the MCP list). Falls back to String()
 * on any non-serialisable input.
 */
const canonicalJson = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = norm(obj[k]);
    return out;
  };
  try {
    return JSON.stringify(norm(value)) ?? 'null';
  } catch {
    return String(value);
  }
};

/** Short, stable, non-reversible fingerprint of an arbitrary JSON-able value. */
const hashOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);

/**
 * Normalise the MCP server list before hashing so the reuse key is
 * INVARIANT to the (turn-to-turn non-deterministic) ordering of
 * `buildKiroMcpServerList` output — otherwise a mere reordering would produce a
 * different key and force a spurious recycle (correctness preserved, but the
 * reuse win is silently lost). Sorts the array by a stable identity
 * (`type` + `name`, falling back to the canonical JSON of the entry) and
 * canonicalises object keys at every depth. A non-array value is hashed as-is.
 */
const canonicalizeMcp = (mcpServers: unknown): string => {
  if (!Array.isArray(mcpServers)) return canonicalJson(mcpServers ?? []);
  const entries = mcpServers.map((s) => {
    const rec = (s ?? {}) as Record<string, unknown>;
    const id = `${String(rec.type ?? '')}\u0000${String(rec.name ?? '')}`;
    return { id, json: canonicalJson(s) };
  });
  // Sort by (type+name) identity, then by canonical JSON as a deterministic
  // tiebreaker for entries that share type+name.
  entries.sort((a, b) => (a.id === b.id ? a.json.localeCompare(b.json) : a.id.localeCompare(b.id)));
  return entries.map((e) => e.json).join(',');
};

/**
 * Build the stable reuse key. The MCP config, API key and cwd are folded in as
 * hashes so any config/credential/cwd change forces a recycle; the API key
 * is NEVER embedded in cleartext. A missing sessionId still yields a key, but
 * the loop only attempts reuse when a persisted sessionId exists (turn ≥ 2), so
 * turn 1 is always cold. Pure. Exported for unit testing.
 */
export const buildReuseKey = (input: ReuseKeyInput): string => {
  const rewind = input.rewindState ? `${input.rewindState.cutoffSK}@${input.rewindState.rewindedAt}` : 'none';
  return [
    `w=${input.workerId}`,
    `s=${input.sessionId ?? ''}`,
    `m=${input.model ?? 'auto'}`,
    `a=${input.agentName ?? ''}`,
    `mcp=${createHash('sha256').update(canonicalizeMcp(input.mcpServers)).digest('hex').slice(0, 16)}`,
    `k=${input.apiKey ? hashOf(input.apiKey) : 'none'}`,
    `cwd=${hashOf(input.cwd ?? '')}`,
    `rw=${rewind}`,
  ].join('|');
};

/**
 * Whether turn-to-turn process reuse is enabled (default ON). Kill-switch:
 * `KIRO_ACP_PROCESS_REUSE=off` restores the per-turn fresh-spawn
 * behaviour (the pool's `tryAcquire` always misses because nothing is ever
 * stored — the loop's `finalizeAgent` disposes instead of storing).
 */
export const kiroProcessReuseEnabled = (): boolean => parseBoolEnvDefaultOn('KIRO_ACP_PROCESS_REUSE');

/** Max age (ms) a pooled process may live before it is recycled (default 6h). */
export const kiroProcessMaxAgeMs = (): number => parseMsEnv('KIRO_ACP_PROCESS_MAX_AGE_MS', 6 * 60 * 60 * 1000);

interface PoolEntry<A extends PoolableAgent> {
  key: string;
  agent: A;
}

/**
 * Single-slot pool for the worker's kiro-cli agent. One worker == one workerId
 * per process, so a single cached entry suffices; a differing key simply
 * evicts the previous entry.
 */
export class KiroAgentPool<A extends PoolableAgent = PoolableAgent> {
  private entry?: PoolEntry<A>;
  private readonly now: () => number;
  private readonly maxAgeMs: () => number;

  constructor(opts?: { now?: () => number; maxAgeMs?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
    this.maxAgeMs = opts?.maxAgeMs ?? kiroProcessMaxAgeMs;
  }

  /**
   * Try to acquire a cached agent for `key`. Returns the agent only when it is
   * a clean, safe reuse: same key, alive, and under max-age. On any miss the
   * stale entry is disposed and dropped, and `undefined` is returned so the
   * caller runs the cold path.
   *
   * (A cancelled turn never reaches here with a cached entry: `finalizeAgent`
   * calls `clear()` on cancel, so the slot is already empty — this is how the
   * "-32603 reuse race after cancel" is avoided without a per-entry flag.)
   */
  async tryAcquire(key: string): Promise<A | undefined> {
    const entry = this.entry;
    if (!entry) return undefined;

    let missReason: string | undefined;
    if (entry.key !== key) missReason = 'config/rewind key changed';
    else if (!entry.agent.isAlive()) missReason = 'subprocess not alive';
    else if (this.now() - entry.agent.createdAt >= this.maxAgeMs()) missReason = 'max-age exceeded';

    if (missReason) {
      console.log(`[kiro-agent-pool] recycling cached agent (${missReason})`);
      this.entry = undefined;
      try {
        await entry.agent.dispose();
      } catch (e) {
        console.warn('[kiro-agent-pool] dispose during recycle threw:', e instanceof Error ? e.message : e);
      }
      return undefined;
    }

    console.log('[kiro-agent-pool] reusing cached kiro-cli agent (turn-to-turn reuse hit)');
    return entry.agent;
  }

  /**
   * Store a healthy agent under `key` for the next turn's reuse. If a different
   * agent was cached, it is disposed first (defensive; normally tryAcquire has
   * already cleared it). Storing the SAME agent again under a (possibly new)
   * key just refreshes the key — no dispose.
   */
  async store(key: string, agent: A): Promise<void> {
    if (this.entry && this.entry.agent !== agent) {
      const stale = this.entry.agent;
      this.entry = undefined;
      try {
        await stale.dispose();
      } catch (e) {
        console.warn('[kiro-agent-pool] dispose of replaced agent threw:', e instanceof Error ? e.message : e);
      }
    }
    this.entry = { key, agent };
  }

  /** Dispose and drop any cached agent (turn cancel / error / mid-turn abandonment). */
  async clear(): Promise<void> {
    const entry = this.entry;
    if (!entry) return;
    this.entry = undefined;
    try {
      await entry.agent.dispose();
    } catch (e) {
      console.warn('[kiro-agent-pool] dispose on clear threw:', e instanceof Error ? e.message : e);
    }
  }

  /** True when `agent` is the currently-cached entry (identity match). */
  isCached(agent: A): boolean {
    return this.entry?.agent === agent;
  }

  /** Test/introspection helper: is an agent currently cached? */
  hasCached(): boolean {
    return this.entry !== undefined;
  }
}

/** Process-wide singleton used by the SDK loop. */
export const kiroAgentPool = new KiroAgentPool();
