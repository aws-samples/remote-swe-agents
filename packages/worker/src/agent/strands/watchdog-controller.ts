/**
 * WatchdogController — extracted from KiroAcpAgent.stream() for testability.
 *
 * Encapsulates the two-tier prompt watchdog (idle + hard wall-clock).
 *
 * Two distinct signals (non-lethal recovery):
 *  - `failure` (Promise<never>): rejects ONLY on the hard wall-clock ceiling.
 *    This is the unconditional runaway guard and is always lethal (the loop
 *    disposes + respawns). Single-deferred pattern: once rejected it
 *    stays rejected, so it fires regardless of yield timing between iterations.
 *  - `idle` (Promise<void>): RESOLVES (does not reject) when the idle timeout
 *    elapses with no tool in-flight. Resolving rather than rejecting lets
 *    `stream()` intercept the idle event and run a non-lethal `session/cancel`
 *    probe BEFORE deciding to kill the subprocess: if kiro-cli acks the cancel
 *    it was actually alive, so the subprocess is preserved and the turn is
 *    re-prompted on the same session. The idle promise is re-armable
 *    (`rearmIdle`) so the controller can keep guarding after a probe that found
 *    the subprocess alive.
 *
 * Legacy parity: ported from the two-tier prompt watchdog of the former
 * hand-written kiro ACP client (same env vars, same defaults, same in-flight
 * deferral semantics — a tool actively in-flight defers idle).
 */

import { parseMsEnv } from './env-parse';

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled']);

export class WatchdogController {
  /** Rejects only on the hard wall-clock ceiling (always lethal). */
  readonly failure: Promise<never>;
  /** Resolves when idle elapses (tool-free). Re-armable via {@link rearmIdle}. */
  idle: Promise<void>;
  /**
   * Resolves periodically WHILE a tool is in-flight, so stream() can run
   * the /proc liveness probe during tool execution (the idle watchdog defers
   * while tools run, so it could never drive a tool-child DEAD verdict). Fires
   * only when at least one tool is in-flight; re-armable via
   * {@link rearmToolProbe}. Disabled when the interval is 0.
   */
  toolProbe: Promise<void>;

  private rejectFn: ((err: Error) => void) | undefined;
  private idleResolveFn: (() => void) | undefined;
  private toolProbeResolveFn: (() => void) | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private hardWallTimer: ReturnType<typeof setTimeout> | undefined;
  private toolProbeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly inFlightTools = new Set<string>();
  private readonly idleTimeoutMs: number;
  private readonly hardWallTimeoutMs: number;
  private readonly toolProbeIntervalMs: number;
  private readonly startMs: number;
  private lastEventMs: number;

  constructor(opts?: { idleMs?: number; hardWallMs?: number; toolProbeMs?: number; now?: number }) {
    this.idleTimeoutMs = opts?.idleMs ?? parseMsEnv('KIRO_ACP_IDLE_TIMEOUT_MS', 600_000);
    this.hardWallTimeoutMs = opts?.hardWallMs ?? parseMsEnv('KIRO_ACP_WALL_CLOCK_HARD_MS', 1_800_000);
    this.toolProbeIntervalMs = opts?.toolProbeMs ?? parseMsEnv('KIRO_ACP_TOOL_PROBE_INTERVAL_MS', 60_000);
    this.startMs = opts?.now ?? Date.now();
    this.lastEventMs = this.startMs;

    this.failure = new Promise<never>((_, reject) => {
      this.rejectFn = reject;
    });
    this.failure.catch(() => {});

    this.idle = new Promise<void>((resolve) => {
      this.idleResolveFn = resolve;
    });

    this.toolProbe = new Promise<void>((resolve) => {
      this.toolProbeResolveFn = resolve;
    });

    this.armHardWall();
    this.refreshIdle();
    this.armToolProbe();
  }

  private elapsedSec(): number {
    return Math.round((Date.now() - this.startMs) / 1000);
  }

  private sinceLastActivitySec(): number {
    return Math.round((Date.now() - this.lastEventMs) / 1000);
  }

  /**
   * Human-readable idle-timeout error wording. Kept identical to the historical
   * message so {@link isPromptTimeoutOrIdleError} / `classifyKiroFailure`
   * recognise it when `stream()` rethrows a confirmed wedge.
   */
  idleErrorMessage(): string {
    return (
      `Kiro ACP prompt idle for ${Math.round(this.idleTimeoutMs / 1000)}s ` +
      `(no agent_message_chunk, tool_call, or tool_call_update; no tool in-flight). ` +
      `elapsed=${this.elapsedSec()}s, lastActivity=${this.sinceLastActivitySec()}s ago`
    );
  }

  private armHardWall(): void {
    if (this.hardWallTimeoutMs <= 0) return;
    this.hardWallTimer = setTimeout(() => {
      this.rejectFn?.(
        new Error(
          `Kiro ACP prompt exceeded hard wall-clock ceiling of ${Math.round(this.hardWallTimeoutMs / 1000)}s ` +
            `measured from turn start; interrupting in-flight work as runaway protection. ` +
            `elapsed=${this.elapsedSec()}s, lastActivity=${this.sinceLastActivitySec()}s ago`
        )
      );
    }, this.hardWallTimeoutMs);
  }

  refreshIdle(): void {
    if (this.idleTimeoutMs <= 0) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.inFlightTools.size > 0) {
        this.refreshIdle();
        return;
      }
      // Resolve (not reject): stream() decides whether this idle is a genuine
      // wedge (via the cancel probe) or a recoverable silence.
      this.idleResolveFn?.();
    }, this.idleTimeoutMs);
  }

  /**
   * Re-arm the idle signal after a non-lethal cancel-probe recovery found the
   * subprocess alive. Installs a fresh `idle` promise and restarts the timer
   * from "now" so the resumed turn is guarded again.
   */
  rearmIdle(): void {
    this.idle = new Promise<void>((resolve) => {
      this.idleResolveFn = resolve;
    });
    this.lastEventMs = Date.now();
    this.refreshIdle();
  }

  private armToolProbe(): void {
    if (this.toolProbeIntervalMs <= 0) return;
    if (this.toolProbeTimer !== undefined) clearTimeout(this.toolProbeTimer);
    this.toolProbeTimer = setTimeout(() => {
      // Only signal when a tool is actually in-flight; otherwise re-arm and
      // wait (the idle watchdog governs the tool-free case).
      if (this.inFlightTools.size > 0) {
        this.toolProbeResolveFn?.();
      } else {
        this.armToolProbe();
      }
    }, this.toolProbeIntervalMs);
  }

  /**
   * Re-arm the tool-liveness probe after stream() has handled one probe tick.
   * Installs a fresh `toolProbe` promise and restarts the interval.
   */
  rearmToolProbe(): void {
    this.toolProbe = new Promise<void>((resolve) => {
      this.toolProbeResolveFn = resolve;
    });
    this.armToolProbe();
  }

  onEvent(): void {
    this.lastEventMs = Date.now();
    this.refreshIdle();
  }

  addToolInFlight(toolCallId: string): void {
    this.inFlightTools.add(toolCallId);
    // Ensure the tool-liveness probe interval is running now that a tool is
    // in-flight (it may have been idling in the tool-free re-arm loop).
    if (this.toolProbeTimer === undefined) this.armToolProbe();
  }

  resolveToolStatus(toolCallId: string, status: string): void {
    if (TERMINAL_TOOL_STATUSES.has(status)) {
      this.inFlightTools.delete(toolCallId);
    }
  }

  get toolsInFlight(): number {
    return this.inFlightTools.size;
  }

  get terminalToolStatuses(): Set<string> {
    return TERMINAL_TOOL_STATUSES;
  }

  cleanup(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.hardWallTimer !== undefined) {
      clearTimeout(this.hardWallTimer);
      this.hardWallTimer = undefined;
    }
    if (this.toolProbeTimer !== undefined) {
      clearTimeout(this.toolProbeTimer);
      this.toolProbeTimer = undefined;
    }
    this.rejectFn = undefined;
    this.idleResolveFn = undefined;
    this.toolProbeResolveFn = undefined;
  }
}
