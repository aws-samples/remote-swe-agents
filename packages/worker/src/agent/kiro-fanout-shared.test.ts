/**
 * Shared fan-out helper tests (mechanised drift guard)
 * =========================================================
 * These pure helpers are used by BOTH the legacy `kiroAgentLoop` and the
 * ACP-SDK `kiroAcpSdkAgentLoop`. Testing them here locks the 5 fan-out
 * behaviours against drift between the loop and the shared helpers:
 *   - normalizeKiroToolName (behaviour 2: MCP namespace / status prefix strip)
 *   - processToolCallDiscardBoundary (behaviour 1: tool-boundary text discard)
 *   - resolveToolResultOutput (never-empty + truncation guard, shared output)
 *
 * The other two behaviours (redelivery suppression, webappMessageAlreadyEmitted)
 * are exercised via the shared `shouldSuppressToolUseRedelivery` /
 * `isMessageDeliveryToolName` (agent-core, separately tested) and the
 * SEND_MESSAGE_TO_USER_NAMES gate; both loops call the identical helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeKiroToolName,
  processToolCallDiscardBoundary,
  resolveToolResultOutput,
  isTerminalToolStatus,
  type ToolBoundaryFlushState,
} from './kiro-loop-helpers';

describe('normalizeKiroToolName (shared behaviour #2)', () => {
  it('strips a "Running: " status prefix', () => {
    expect(normalizeKiroToolName('Running: echo hello')).toBe('echo hello');
  });
  it('strips a leading @namespace/ MCP prefix', () => {
    expect(normalizeKiroToolName('@remote-swe/sendMessageToUser')).toBe('sendMessageToUser');
  });
  it('strips BOTH status prefix and MCP namespace', () => {
    expect(normalizeKiroToolName('Executing: @remote-swe/sendFileToUser')).toBe('sendFileToUser');
  });
  it('leaves a bare native tool name unchanged', () => {
    expect(normalizeKiroToolName('fs_read')).toBe('fs_read');
  });
});

describe('processToolCallDiscardBoundary (shared behaviour #1)', () => {
  it('drains bufferedRawText into discardedRawSoFar and resets the buffer', () => {
    const s: ToolBoundaryFlushState = { bufferedRawText: 'thinking before tool', discardedRawSoFar: '' };
    processToolCallDiscardBoundary(s);
    expect(s.bufferedRawText).toBe('');
    expect(s.discardedRawSoFar).toBe('thinking before tool');
  });
  it('accumulates across multiple boundaries', () => {
    const s: ToolBoundaryFlushState = { bufferedRawText: 'a', discardedRawSoFar: '' };
    processToolCallDiscardBoundary(s);
    s.bufferedRawText = 'b';
    processToolCallDiscardBoundary(s);
    expect(s.discardedRawSoFar).toBe('ab');
    expect(s.bufferedRawText).toBe('');
  });
  it('is a no-op on an empty buffer', () => {
    const s: ToolBoundaryFlushState = { bufferedRawText: '', discardedRawSoFar: 'x' };
    processToolCallDiscardBoundary(s);
    expect(s.discardedRawSoFar).toBe('x');
  });
});

describe('isTerminalToolStatus (shared terminal-status guard)', () => {
  it('treats completed / failed as terminal', () => {
    expect(isTerminalToolStatus('completed')).toBe(true);
    expect(isTerminalToolStatus('failed')).toBe(true);
  });
  it('treats non-terminal statuses as NOT terminal (v2 initial "", v3 in_progress, pending)', () => {
    expect(isTerminalToolStatus('')).toBe(false);
    expect(isTerminalToolStatus('in_progress')).toBe(false);
    expect(isTerminalToolStatus('pending')).toBe(false);
  });

  it('v3 update sequence (in_progress×2 → completed) yields exactly ONE terminal update', () => {
    // v3 emits three tool_call_update events for one tool.
    // Only the final `completed` must pass the guard; the two in_progress must
    // be dropped so the loop persists the real output once, not a placeholder.
    const v3Sequence = ['in_progress', 'in_progress', 'completed'];
    const passed = v3Sequence.filter((s) => isTerminalToolStatus(s));
    expect(passed).toEqual(['completed']);
  });

  it('v2 update sequence ("" → completed) yields exactly ONE terminal update', () => {
    const v2Sequence = ['', 'completed'];
    const passed = v2Sequence.filter((s) => isTerminalToolStatus(s));
    expect(passed).toEqual(['completed']);
  });
});

describe('resolveToolResultOutput (shared never-empty + truncation guard)', () => {
  it('returns the output for a normal completed tool', () => {
    expect(resolveToolResultOutput('completed', 'hello')).toBe('hello');
  });
  it('never returns empty for a successful no-content tool', () => {
    expect(resolveToolResultOutput('completed', '')).toBe('Tool executed successfully (no content returned).');
  });
  it('never returns empty when kiro omitted rawOutput on a completed tool', () => {
    expect(resolveToolResultOutput('completed', undefined)).toBe('Tool executed successfully (no output reported).');
  });
  it('uses a failure placeholder when a failed tool has no output', () => {
    expect(resolveToolResultOutput('failed', undefined)).toBe('Tool failed.');
    expect(resolveToolResultOutput('failed', '')).toBe('Tool failed.');
  });
  it('surfaces the failure output when present', () => {
    expect(resolveToolResultOutput('failed', 'stack trace')).toBe('stack trace');
  });
  it('truncates very long output', () => {
    const long = 'x'.repeat(200_000);
    const out = resolveToolResultOutput('completed', long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('(truncated)');
  });
});
