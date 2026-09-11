/**
 * Stale-pid recovery tests for the SDK loop (Option C: legacy parity wiring).
 *
 * The v3 engine is lock-free, so this path is normally
 * dormant. These tests verify the detection regex and kill-sequence wiring
 * via synthetic errors — ensuring correct trigger/non-trigger behaviour.
 */
import { describe, it, expect } from 'vitest';
import { parseActiveProcessPid, killStaleKiroProcess, type StaleKillResult } from './kiro-loop-helpers';

describe('stale-pid detection: parseActiveProcessPid', () => {
  it('extracts PID from exact lock error format', () => {
    const msg = 'Session is active in another process (PID 904)';
    expect(parseActiveProcessPid(msg)).toBe(904);
  });

  it('extracts PID from JSON-RPC wrapped error', () => {
    const msg = '{"code":-32000,"message":"Session is active in another process (PID 67)"}';
    expect(parseActiveProcessPid(msg)).toBe(67);
  });

  it('extracts PID with whitespace between text and parens', () => {
    const msg = 'Session is active in another process  (PID  1234)';
    expect(parseActiveProcessPid(msg)).toBe(1234);
  });

  it('returns undefined for unrelated error with PID-like numbers', () => {
    const msg = 'Connection refused: port 8080, retry after 500ms (attempt 3/5)';
    expect(parseActiveProcessPid(msg)).toBeUndefined();
  });

  it('returns undefined for error mentioning "PID" in different context', () => {
    const msg = 'Process PID 999 exited with code 1';
    expect(parseActiveProcessPid(msg)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseActiveProcessPid('')).toBeUndefined();
  });

  it('returns undefined for PID <= 1', () => {
    const msg = 'Session is active in another process (PID 1)';
    expect(parseActiveProcessPid(msg)).toBeUndefined();
  });

  it('returns undefined for PID 0', () => {
    const msg = 'Session is active in another process (PID 0)';
    expect(parseActiveProcessPid(msg)).toBeUndefined();
  });

  it('returns undefined for non-numeric PID', () => {
    const msg = 'Session is active in another process (PID abc)';
    expect(parseActiveProcessPid(msg)).toBeUndefined();
  });
});

describe('stale-pid kill sequence: killStaleKiroProcess', () => {
  it('kills a valid stale kiro-cli process', () => {
    let killed = false;
    const result = killStaleKiroProcess(123, {
      commLookup: () => 'kiro-cli',
      kill: () => {
        killed = true;
      },
      livePid: 456,
    });
    expect(result).toBe('killed');
    expect(killed).toBe(true);
  });

  it('refuses to kill own live subprocess (refused-self)', () => {
    const result = killStaleKiroProcess(67, {
      commLookup: () => 'kiro-cli',
      kill: () => {
        throw new Error('should not be called');
      },
      livePid: 67,
    });
    expect(result).toBe('refused-self');
  });

  it('refuses when comm does not match kiro-cli (refused-other)', () => {
    const result = killStaleKiroProcess(200, {
      commLookup: () => 'node',
      kill: () => {
        throw new Error('should not be called');
      },
      livePid: 100,
    });
    expect(result).toBe('refused-other');
  });

  it('returns gone when process does not exist', () => {
    const result = killStaleKiroProcess(999, {
      commLookup: () => undefined,
      kill: () => {
        throw new Error('should not be called');
      },
      livePid: 100,
    });
    expect(result).toBe('gone');
  });

  it('refuses PID <= 1', () => {
    const result = killStaleKiroProcess(1, {
      commLookup: () => 'kiro-cli',
      kill: () => {
        throw new Error('should not be called');
      },
    });
    expect(result).toBe('refused-other');
  });

  it('returns refused-other when kill throws', () => {
    const result = killStaleKiroProcess(300, {
      commLookup: () => 'kiro-cli',
      kill: () => {
        throw new Error('EPERM');
      },
      livePid: 100,
    });
    expect(result).toBe('refused-other');
  });
});
