/**
 * WatchdogController unit tests — exercises the REAL controller class with
 * fake timers.
 *
 * Contract: the idle watchdog RESOLVES `wd.idle` (a recoverable
 * signal that stream() turns into a non-lethal cancel probe) instead of
 * rejecting `wd.failure`. `wd.failure` rejects ONLY on the hard wall-clock
 * ceiling (always lethal). The in-flight deferral + single-deferred pattern
 * semantics are unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WatchdogController } from './watchdog-controller';

/** Resolves true if `p` settles (resolve) before a fake-timer flush, else false. */
const settled = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe('WatchdogController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('idle promise resolves after idleMs when no events arrive (recoverable signal)', async () => {
    const wd = new WatchdogController({ idleMs: 100, hardWallMs: 0 });
    let idleFired = false;
    void wd.idle.then(() => {
      idleFired = true;
    });
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(idleFired).toBe(true);
    // idle does NOT reject failure — failure is reserved for the hard wall.
    wd.cleanup();
  });

  it('idleErrorMessage carries the idle wording recognised by classifyKiroFailure', () => {
    const wd = new WatchdogController({ idleMs: 100, hardWallMs: 0 });
    expect(wd.idleErrorMessage()).toContain('idle for');
    wd.cleanup();
  });

  it('hard wall REJECTS failure unconditionally after hardWallMs', async () => {
    const wd = new WatchdogController({ idleMs: 0, hardWallMs: 200 });
    const p = wd.failure.catch((e: Error) => e.message);
    vi.advanceTimersByTime(200);
    const msg = await p;
    expect(msg).toContain('hard wall-clock ceiling');
    wd.cleanup();
  });

  it('onEvent resets idle timer (no resolve if events keep arriving)', async () => {
    const wd = new WatchdogController({ idleMs: 100, hardWallMs: 0 });
    let idleFired = false;
    void wd.idle.then(() => {
      idleFired = true;
    });

    vi.advanceTimersByTime(80);
    wd.onEvent(); // reset
    vi.advanceTimersByTime(80);
    wd.onEvent(); // reset again
    vi.advanceTimersByTime(80);
    await Promise.resolve();

    expect(idleFired).toBe(false);
    wd.cleanup();
  });

  it('idle defers while tools are in-flight, resolves after tool completes', async () => {
    const wd = new WatchdogController({ idleMs: 100, hardWallMs: 0 });
    let idleFired = false;
    void wd.idle.then(() => {
      idleFired = true;
    });

    wd.addToolInFlight('tool-1');
    vi.advanceTimersByTime(200); // idle elapses but defers (tool in-flight)
    await Promise.resolve();
    expect(idleFired).toBe(false);

    wd.resolveToolStatus('tool-1', 'completed');
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(idleFired).toBe(true);
    wd.cleanup();
  });

  it('hard wall fires even with in-flight tools (runaway guard)', async () => {
    const wd = new WatchdogController({ idleMs: 0, hardWallMs: 200 });
    wd.addToolInFlight('tool-1');
    const p = wd.failure.catch((e: Error) => e.message);
    vi.advanceTimersByTime(200);
    const msg = await p;
    expect(msg).toContain('hard wall-clock ceiling');
    wd.cleanup();
  });

  it('single-deferred hard wall: reject during yield gap is captured by next race', async () => {
    const wd = new WatchdogController({ idleMs: 0, hardWallMs: 100 });

    // Simulate first iteration resolving (event arrives before hard wall)
    const event1 = Promise.resolve('event');
    const r1 = await Promise.race([event1, wd.failure]);
    expect(r1).toBe('event');

    // Now hard wall fires (during "yield gap" — between iterations)
    vi.advanceTimersByTime(100);

    // Next race with a never-resolving promise — deferred already rejected
    const never = new Promise<string>(() => {});
    await expect(Promise.race([never, wd.failure])).rejects.toThrow('hard wall-clock ceiling');
    wd.cleanup();
  });

  it('rearmIdle installs a fresh idle promise after a recovery', async () => {
    const wd = new WatchdogController({ idleMs: 100, hardWallMs: 0 });
    const firstIdle = wd.idle;
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(await settled(firstIdle)).toBe(true);

    // Re-arm: a NEW idle promise is installed and must not be already settled.
    wd.rearmIdle();
    const secondIdle = wd.idle;
    expect(secondIdle).not.toBe(firstIdle);
    expect(await settled(secondIdle)).toBe(false);

    // It fires again after another idle window.
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(await settled(secondIdle)).toBe(true);
    wd.cleanup();
  });

  it('cleanup prevents late fires (idle + hard wall)', async () => {
    const wd = new WatchdogController({ idleMs: 100, hardWallMs: 200 });
    let idleFired = false;
    let failed = false;
    void wd.idle.then(() => {
      idleFired = true;
    });
    wd.failure.catch(() => {
      failed = true;
    });

    wd.cleanup();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(idleFired).toBe(false);
    expect(failed).toBe(false);
  });

  it('non-terminal tool status does not remove from in-flight set', async () => {
    const wd = new WatchdogController({ idleMs: 100, hardWallMs: 0 });
    let idleFired = false;
    void wd.idle.then(() => {
      idleFired = true;
    });

    wd.addToolInFlight('tool-1');
    wd.resolveToolStatus('tool-1', 'in_progress'); // non-terminal
    vi.advanceTimersByTime(200); // idle defers because tool still in-flight
    await Promise.resolve();
    expect(idleFired).toBe(false);

    wd.resolveToolStatus('tool-1', 'failed'); // terminal
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(idleFired).toBe(true);
    wd.cleanup();
  });

  // The tool-liveness probe fires WHILE a tool is in-flight (the idle
  // watchdog defers in that case), so stream() can run the /proc probe with
  // expectToolChild=true and reach a DEAD verdict.
  it('toolProbe resolves after the interval only while a tool is in-flight', async () => {
    const wd = new WatchdogController({ idleMs: 0, hardWallMs: 0, toolProbeMs: 100 });
    let firedNoTool = false;
    void wd.toolProbe.then(() => {
      firedNoTool = true;
    });
    // No tool in-flight → the probe interval elapses but re-arms without firing.
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(firedNoTool).toBe(false);

    // A tool goes in-flight → the next interval fires the probe.
    wd.addToolInFlight('t1');
    let firedWithTool = false;
    void wd.toolProbe.then(() => {
      firedWithTool = true;
    });
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(firedWithTool).toBe(true);
    wd.cleanup();
  });

  it('toolProbe interval 0 disables it', async () => {
    const wd = new WatchdogController({ idleMs: 0, hardWallMs: 0, toolProbeMs: 0 });
    let fired = false;
    void wd.toolProbe.then(() => {
      fired = true;
    });
    wd.addToolInFlight('t1');
    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(fired).toBe(false);
    wd.cleanup();
  });

  it('rearmToolProbe installs a fresh promise that fires again while in-flight', async () => {
    const wd = new WatchdogController({ idleMs: 0, hardWallMs: 0, toolProbeMs: 100 });
    wd.addToolInFlight('t1');
    const first = wd.toolProbe;
    vi.advanceTimersByTime(100);
    await Promise.resolve();

    wd.rearmToolProbe();
    const second = wd.toolProbe;
    expect(second).not.toBe(first);
    let secondFired = false;
    void second.then(() => {
      secondFired = true;
    });
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(secondFired).toBe(true);
    wd.cleanup();
  });
});
