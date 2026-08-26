/**
 * Measurement-based subprocess liveness via /proc.
 * Exercises the REAL production functions with injected /proc readers — no
 * host /proc dependency, no re-implementation of the classification policy.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  parseProcStat,
  collectDescendants,
  classifyLiveness,
  probeSubprocessLiveness,
  kiroProcLivenessEnabled,
  measureNewDescendantActivity,
  decideToolProbeVerdict,
  initialToolProbeState,
  captureBaselinePids,
  type ProcStat,
  type NewDescendantMeasurement,
  type ToolProbeState,
} from './proc-liveness';

// Build a synthetic /proc/<pid>/stat line. Layout: pid (comm) state ppid ...
// utime(14) stime(15) ... starttime(22). We only need through stime.
const statLine = (pid: number, comm: string, state: string, ppid: number, utime: number, stime: number): string => {
  // fields 5..13 (pgrp..cutime) are placeholders; we pad up to stime (field 15).
  const pad = Array(9).fill('0'); // fields 5..13 (9 fields between ppid and utime)
  return `${pid} (${comm}) ${state} ${ppid} ${pad.join(' ')} ${utime} ${stime} 0 0 0 0 0 0 20 0 1 0 12345`;
};

describe('parseProcStat', () => {
  it('parses state/ppid/cpuTicks, tolerating spaces/parens in comm', () => {
    const s = parseProcStat(100, statLine(100, 'my (weird) proc', 'R', 67, 11, 22));
    expect(s).toEqual<ProcStat>({ pid: 100, ppid: 67, state: 'R', cpuTicks: 33 });
  });

  it('returns undefined on malformed lines', () => {
    expect(parseProcStat(1, 'no-paren-here')).toBeUndefined();
    expect(parseProcStat(1, '1 (x) ')).toBeUndefined();
  });
});

describe('collectDescendants', () => {
  // Tree: root=67 → child 100 → grandchild 200; unrelated 300 (ppid 1).
  const lines: Record<number, string> = {
    67: statLine(67, 'kiro-cli', 'S', 1, 0, 0),
    100: statLine(100, 'bash', 'S', 67, 1, 1),
    200: statLine(200, 'tsc', 'R', 100, 5, 5),
    300: statLine(300, 'other', 'S', 1, 0, 0),
  };
  const deps = {
    readStat: (pid: number) => lines[pid],
    listPids: () => Object.keys(lines).map(Number),
  };

  it('collects children + grandchildren, excludes root and unrelated', () => {
    const d = collectDescendants(67, deps)
      .map((s) => s.pid)
      .sort((a, b) => a - b);
    expect(d).toEqual([100, 200]);
  });

  it('returns empty when root has no children', () => {
    expect(collectDescendants(999, deps)).toEqual([]);
  });
});

describe('classifyLiveness', () => {
  const stat = (pid: number, state: string, cpuTicks: number): ProcStat => ({ pid, ppid: 67, state, cpuTicks });

  it('ALIVE_ACTIVE when a descendant is running (R) in either sample', () => {
    expect(
      classifyLiveness([stat(1, 'R', 10)], [stat(1, 'S', 10)], { expectToolChild: true, rootReadable: true })
    ).toBe('ALIVE_ACTIVE');
    expect(
      classifyLiveness([stat(1, 'S', 10)], [stat(1, 'D', 10)], { expectToolChild: false, rootReadable: true })
    ).toBe('ALIVE_ACTIVE');
  });

  it('ALIVE_ACTIVE when descendant CPU advances beyond the tick threshold between samples', () => {
    expect(
      classifyLiveness([stat(1, 'S', 10)], [stat(1, 'S', 15)], { expectToolChild: false, rootReadable: true })
    ).toBe('ALIVE_ACTIVE');
  });

  it('a 1-tick idle-tick CPU delta does NOT count as ALIVE_ACTIVE (resident MCP noise)', () => {
    // Delta of exactly 1 tick (resident stdio MCP event-loop wake) must not
    // read as an active tool. With no expected tool child + present idle
    // descendant, this is UNKNOWN, not a false ALIVE_ACTIVE.
    expect(
      classifyLiveness([stat(1, 'S', 10)], [stat(1, 'S', 11)], { expectToolChild: false, rootReadable: true })
    ).toBe('UNKNOWN');
  });

  it('DEAD when a tool child was expected but the tree is empty at both samples (root readable)', () => {
    expect(classifyLiveness([], [], { expectToolChild: true, rootReadable: true })).toBe('DEAD');
  });

  it('UNKNOWN (not DEAD) when the tree is empty but root is unreadable (fail-safe)', () => {
    expect(classifyLiveness([], [], { expectToolChild: true, rootReadable: false })).toBe('UNKNOWN');
  });

  it('UNKNOWN when no tool child expected (kiro-cli itself just idle/sleeping)', () => {
    expect(classifyLiveness([], [], { expectToolChild: false, rootReadable: true })).toBe('UNKNOWN');
  });

  it('UNKNOWN when descendants exist but are idle (S) with no CPU movement', () => {
    expect(
      classifyLiveness([stat(1, 'S', 10)], [stat(1, 'S', 10)], { expectToolChild: true, rootReadable: true })
    ).toBe('UNKNOWN');
  });
});

describe('probeSubprocessLiveness (async, injected deps)', () => {
  const noSleep = () => Promise.resolve();

  it('UNKNOWN immediately for an invalid rootPid', async () => {
    await expect(probeSubprocessLiveness(undefined, { expectToolChild: true }, { sleep: noSleep })).resolves.toBe(
      'UNKNOWN'
    );
    await expect(probeSubprocessLiveness(0, { expectToolChild: true }, { sleep: noSleep })).resolves.toBe('UNKNOWN');
  });

  it('ALIVE_ACTIVE when an injected /proc shows a running tool child', async () => {
    const lines: Record<number, string> = {
      67: statLine(67, 'kiro-cli', 'S', 1, 0, 0),
      100: statLine(100, 'tsc', 'R', 67, 3, 4),
    };
    const verdict = await probeSubprocessLiveness(
      67,
      { expectToolChild: true },
      { readStat: (p) => lines[p], listPids: () => Object.keys(lines).map(Number), sleep: noSleep }
    );
    expect(verdict).toBe('ALIVE_ACTIVE');
  });

  it('DEAD when the expected tool child vanished and root is readable', async () => {
    const lines: Record<number, string> = { 67: statLine(67, 'kiro-cli', 'S', 1, 0, 0) };
    const verdict = await probeSubprocessLiveness(
      67,
      { expectToolChild: true },
      { readStat: (p) => lines[p], listPids: () => Object.keys(lines).map(Number), sleep: noSleep }
    );
    expect(verdict).toBe('DEAD');
  });

  it('UNKNOWN (fail-safe) when readStat throws', async () => {
    const verdict = await probeSubprocessLiveness(
      67,
      { expectToolChild: true },
      {
        readStat: () => {
          throw new Error('EACCES');
        },
        listPids: () => {
          throw new Error('EACCES');
        },
        sleep: noSleep,
      }
    );
    expect(verdict).toBe('UNKNOWN');
  });
});

describe('kiroProcLivenessEnabled', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('default ON, off-forms disable', () => {
    expect(kiroProcLivenessEnabled()).toBe(true);
    for (const off of ['0', 'false', 'off', 'no']) {
      vi.stubEnv('KIRO_ACP_PROC_LIVENESS', off);
      expect(kiroProcLivenessEnabled()).toBe(false);
    }
    vi.stubEnv('KIRO_ACP_PROC_LIVENESS', 'on');
    expect(kiroProcLivenessEnabled()).toBe(true);
  });
});

describe('decideToolProbeVerdict (tool-liveness state machine)', () => {
  const m = (o: Partial<NewDescendantMeasurement>): NewDescendantMeasurement => ({
    present: false,
    active: false,
    rootReadable: true,
    ...o,
  });

  const s = (o: Partial<ToolProbeState> = {}): ToolProbeState => ({ sawChild: false, absentStreak: 0, ...o });

  it('active new descendant → ALIVE, records sawChild, resets streak', () => {
    expect(decideToolProbeVerdict(s(), m({ present: true, active: true }))).toEqual({
      verdict: 'ALIVE',
      state: { sawChild: true, absentStreak: 0 },
    });
  });

  it('present-but-idle new descendant → WAIT, records sawChild, resets streak', () => {
    expect(decideToolProbeVerdict(s({ absentStreak: 1 }), m({ present: true, active: false }))).toEqual({
      verdict: 'WAIT',
      state: { sawChild: true, absentStreak: 0 },
    });
  });

  it('FIRST absent tick after a child was seen → WAIT (debounced), streak=1 (not DEAD yet)', () => {
    expect(decideToolProbeVerdict(s({ sawChild: true }), m({ present: false, active: false }))).toEqual({
      verdict: 'WAIT',
      state: { sawChild: true, absentStreak: 1 },
    });
  });

  it('SECOND consecutive absent tick → DEAD (child vanished for real)', () => {
    expect(
      decideToolProbeVerdict(s({ sawChild: true, absentStreak: 1 }), m({ present: false, active: false }))
    ).toEqual({
      verdict: 'DEAD',
      state: { sawChild: true, absentStreak: 2 },
    });
  });

  it('an intervening present tick RESETS the streak (transient absence is not fatal)', () => {
    // saw child (absent once) → present again → absent once more must NOT be DEAD.
    const afterPresent = decideToolProbeVerdict(
      s({ sawChild: true, absentStreak: 1 }),
      m({ present: true, active: false })
    );
    expect(afterPresent).toEqual({ verdict: 'WAIT', state: { sawChild: true, absentStreak: 0 } });
    const afterAbsent = decideToolProbeVerdict(afterPresent.state, m({ present: false, active: false }));
    expect(afterAbsent.verdict).toBe('WAIT');
    expect(afterAbsent.state.absentStreak).toBe(1);
  });

  it('no new descendant and never saw one → WAIT (MCP in-process tool / not spawned yet), streak stays 0', () => {
    // This is the production-default case that made the old DEAD unreachable:
    // resident MCP servers are baseline-excluded, an in-process MCP tool spawns
    // no child, so we must NOT flag DEAD nor advance the DEAD countdown.
    expect(decideToolProbeVerdict(s(), m({ present: false, active: false }))).toEqual({
      verdict: 'WAIT',
      state: { sawChild: false, absentStreak: 0 },
    });
  });

  it('unreadable /proc → WAIT, streak reset, sawChild preserved (fail-safe: never DEAD, never advances countdown)', () => {
    expect(
      decideToolProbeVerdict(
        s({ sawChild: true, absentStreak: 1 }),
        m({ present: false, active: false, rootReadable: false })
      )
    ).toEqual({
      verdict: 'WAIT',
      state: { sawChild: true, absentStreak: 0 },
    });
    expect(decideToolProbeVerdict(s(), m({ present: false, active: false, rootReadable: false }))).toEqual({
      verdict: 'WAIT',
      state: { sawChild: false, absentStreak: 0 },
    });
  });

  it('reachable DEAD sequence: active child, then two consecutive absent ticks', () => {
    // tick 1: new child active → ALIVE
    const t1 = decideToolProbeVerdict(initialToolProbeState(), m({ present: true, active: true }));
    expect(t1.verdict).toBe('ALIVE');
    // tick 2: child gone once → WAIT (debounced)
    const t2 = decideToolProbeVerdict(t1.state, m({ present: false, active: false }));
    expect(t2.verdict).toBe('WAIT');
    // tick 3: still gone → DEAD
    const t3 = decideToolProbeVerdict(t2.state, m({ present: false, active: false }));
    expect(t3.verdict).toBe('DEAD');
  });
});

describe('measureNewDescendantActivity (baseline exclusion)', () => {
  const noSleep = () => Promise.resolve();

  it('excludes baseline (resident MCP) pids → not present when only baseline children exist', async () => {
    const lines: Record<number, string> = {
      67: statLine(67, 'kiro-cli', 'S', 1, 0, 0),
      100: statLine(100, 'mcp-server', 'S', 67, 0, 0), // resident MCP (baseline)
    };
    const res = await measureNewDescendantActivity(67, new Set([100]), {
      readStat: (p) => lines[p],
      listPids: () => Object.keys(lines).map(Number),
      sleep: noSleep,
    });
    expect(res.present).toBe(false);
    expect(res.active).toBe(false);
    expect(res.rootReadable).toBe(true);
  });

  it('detects a NEW active tool child (not in baseline)', async () => {
    const lines: Record<number, string> = {
      67: statLine(67, 'kiro-cli', 'S', 1, 0, 0),
      100: statLine(100, 'mcp-server', 'S', 67, 0, 0), // baseline
      200: statLine(200, 'sh', 'R', 67, 5, 5), // new tool child, running
    };
    const res = await measureNewDescendantActivity(67, new Set([100]), {
      readStat: (p) => lines[p],
      listPids: () => Object.keys(lines).map(Number),
      sleep: noSleep,
    });
    expect(res.present).toBe(true);
    expect(res.active).toBe(true);
  });

  it('invalid rootPid or read failure → safe non-present reading', async () => {
    await expect(measureNewDescendantActivity(undefined, new Set(), { sleep: noSleep })).resolves.toEqual({
      present: false,
      active: false,
      rootReadable: false,
    });
  });
});

describe('captureBaselinePids', () => {
  it('captures current descendants as the baseline set', () => {
    const lines: Record<number, string> = {
      67: statLine(67, 'kiro-cli', 'S', 1, 0, 0),
      100: statLine(100, 'mcp-a', 'S', 67, 0, 0),
      200: statLine(200, 'mcp-b', 'S', 100, 0, 0),
    };
    const baseline = captureBaselinePids(67, {
      readStat: (p) => lines[p],
      listPids: () => Object.keys(lines).map(Number),
    });
    expect([...baseline].sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it('invalid rootPid → empty baseline', () => {
    expect(captureBaselinePids(undefined).size).toBe(0);
  });
});
