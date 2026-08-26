import { describe, expect, test } from 'vitest';
import {
  CANONICAL_KIRO_FAILURE_MESSAGE,
  isKnownKiroInternalError,
  isPromptTimeoutOrIdleError,
  toUserFacingTurnError,
} from './kiro-error-classification';
import { PROMPT_SETTLE_WEDGED_ERROR } from './kiro-acp-types';

// The raw kiro-cli infrastructure errors observed leaking to the UX.
const RAW_WEDGED = `[System] Prompt failed after retry: ${PROMPT_SETTLE_WEDGED_ERROR}`;
const RAW_INTERNAL =
  'session/prompt failed: {"code":-32603,"message":"Internal error","data":"Kiro failed to generate a response"}';
const RAW_DIED = 'Kiro CLI error: Kiro CLI process died during prompt';
const RAW_IDLE = 'Kiro ACP prompt idle for 600s (no agent_message_chunk ...)';

describe('isPromptTimeoutOrIdleError (shared)', () => {
  test('recognises wedged / idle / wall-clock / timed-out', () => {
    expect(isPromptTimeoutOrIdleError(PROMPT_SETTLE_WEDGED_ERROR)).toBe(true);
    expect(isPromptTimeoutOrIdleError(RAW_IDLE)).toBe(true);
    expect(isPromptTimeoutOrIdleError('exceeded hard wall-clock ceiling')).toBe(true);
    expect(isPromptTimeoutOrIdleError('session/prompt timed out')).toBe(true);
  });

  test('does NOT match an unrelated -32603 (handled by the generic retry branch)', () => {
    expect(
      isPromptTimeoutOrIdleError(
        'session/prompt failed: {"code":-32603,"message":"Internal error","data":"Prompt already in progress"}'
      )
    ).toBe(false);
  });
});

describe('isKnownKiroInternalError (UX-suppression superset)', () => {
  test('recognises the leaking infra errors', () => {
    expect(isKnownKiroInternalError(RAW_WEDGED)).toBe(true);
    expect(isKnownKiroInternalError(RAW_INTERNAL)).toBe(true);
    expect(isKnownKiroInternalError(RAW_DIED)).toBe(true);
    expect(isKnownKiroInternalError(RAW_IDLE)).toBe(true);
  });

  test('passes through genuinely actionable errors', () => {
    expect(isKnownKiroInternalError('TypeError: cannot read property x of undefined')).toBe(false);
    expect(isKnownKiroInternalError('git push rejected: non-fast-forward')).toBe(false);
  });

  test('recognises "prompt cancelled" as a known kiro internal error', () => {
    expect(isKnownKiroInternalError('Kiro ACP prompt cancelled')).toBe(true);
    expect(isKnownKiroInternalError('Kiro CLI error: Kiro ACP prompt cancelled')).toBe(true);
  });

  // handleTurnError applies this to ALL uncaught errors, so a NON-kiro
  // error that merely contains a generic phrase ("Internal error" / "timed
  // out" / "-32603") must NOT be collapsed — only errors that ALSO carry a
  // kiro-specific marker qualify.
  test('generic phrases without a kiro marker are NOT treated as kiro errors', () => {
    expect(isKnownKiroInternalError('DynamoDB request timed out after 5000ms')).toBe(false);
    expect(isKnownKiroInternalError('S3 Internal error: please retry')).toBe(false);
    expect(isKnownKiroInternalError('RPC failed with code -32603 from some other server')).toBe(false);
    expect(isKnownKiroInternalError('The child process died unexpectedly')).toBe(false);
    // ...but the SAME payloads WITH a kiro marker ARE recognised.
    expect(isKnownKiroInternalError('session/prompt failed: {"code":-32603,"message":"Internal error"}')).toBe(true);
    expect(isKnownKiroInternalError('Kiro CLI error: Kiro CLI process died during prompt')).toBe(true);
  });
});

describe('toUserFacingTurnError', () => {
  test('collapses recognised infra errors to the canonical phrase', () => {
    expect(toUserFacingTurnError(RAW_WEDGED)).toBe(CANONICAL_KIRO_FAILURE_MESSAGE);
    expect(toUserFacingTurnError(RAW_INTERNAL)).toBe(CANONICAL_KIRO_FAILURE_MESSAGE);
    expect(toUserFacingTurnError(RAW_DIED)).toBe(CANONICAL_KIRO_FAILURE_MESSAGE);
  });

  test('the canonical phrase leaks none of the raw signal', () => {
    expect(CANONICAL_KIRO_FAILURE_MESSAGE).not.toContain('-32603');
    expect(CANONICAL_KIRO_FAILURE_MESSAGE).not.toContain('wedged');
    expect(CANONICAL_KIRO_FAILURE_MESSAGE).not.toContain('session/prompt');
  });

  test('passes actionable errors through unchanged', () => {
    expect(toUserFacingTurnError('Custom tool failed: bad arg')).toBe('Custom tool failed: bad arg');
  });
});
