/**
 * MF-1 regression tests: model-switch failure notification dedup guard.
 * Exercises the REAL `handleModelSwitchOutcome` function (the production
 * if/set/delete wiring), not raw Map manipulation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelSwitchFailureNotifiedFor, handleModelSwitchOutcome } from './kiro-acp-sdk-agent-loop';
import type { RotationResult } from './strands/rotate-session-for-model';

describe('MF-1: model-switch failure notification dedup guard', () => {
  const workerId = 'w-dedup-test';

  beforeEach(() => {
    modelSwitchFailureNotifiedFor.clear();
  });

  it('same desired model fails twice → notified only once', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const failResult: RotationResult = { ok: false, reason: 'synth error' };

    await handleModelSwitchOutcome({
      rotationResult: failResult,
      workerId,
      currentSessionId: 'sess-1',
      desiredLabel: 'claude-sonnet-4.5',
      liveLabel: () => 'claude-haiku-4.5',
      slackUserId: undefined,
      notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);

    await handleModelSwitchOutcome({
      rotationResult: failResult,
      workerId,
      currentSessionId: 'sess-1',
      desiredLabel: 'claude-sonnet-4.5',
      liveLabel: () => 'claude-haiku-4.5',
      slackUserId: undefined,
      notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('success clears guard → re-failure re-notifies', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const failResult: RotationResult = { ok: false, reason: 'synth error' };
    const okResult: RotationResult = { ok: true, newSessionId: 'sess-new', persisted: true };

    await handleModelSwitchOutcome({
      rotationResult: failResult,
      workerId,
      currentSessionId: 'sess-1',
      desiredLabel: 'claude-sonnet-4.5',
      liveLabel: () => 'claude-haiku-4.5',
      slackUserId: undefined,
      notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);

    await handleModelSwitchOutcome({
      rotationResult: okResult,
      workerId,
      currentSessionId: 'sess-1',
      desiredLabel: 'claude-sonnet-4.5',
      liveLabel: () => 'claude-sonnet-4.5',
      slackUserId: undefined,
      notify,
    });
    expect(modelSwitchFailureNotifiedFor.has(workerId)).toBe(false);

    await handleModelSwitchOutcome({
      rotationResult: failResult,
      workerId,
      currentSessionId: 'sess-1',
      desiredLabel: 'claude-sonnet-4.5',
      liveLabel: () => 'claude-haiku-4.5',
      slackUserId: undefined,
      notify,
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('success returns new sessionId from rotation result', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const okResult: RotationResult = { ok: true, newSessionId: 'sess-rotated', persisted: true };

    const outcome = await handleModelSwitchOutcome({
      rotationResult: okResult,
      workerId,
      currentSessionId: 'sess-old',
      desiredLabel: 'claude-sonnet-4.5',
      liveLabel: () => 'claude-sonnet-4.5',
      slackUserId: undefined,
      notify,
    });
    expect(outcome.effectiveSessionId).toBe('sess-rotated');
    expect(outcome.notified).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('failure returns current sessionId (stays on previous model)', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const failResult: RotationResult = { ok: false, reason: 'boom' };

    const outcome = await handleModelSwitchOutcome({
      rotationResult: failResult,
      workerId,
      currentSessionId: 'sess-old',
      desiredLabel: 'claude-sonnet-4.5',
      liveLabel: () => 'claude-haiku-4.5',
      slackUserId: undefined,
      notify,
    });
    expect(outcome.effectiveSessionId).toBe('sess-old');
    expect(outcome.notified).toBe(true);
  });

  it('includes slackUserId mention when available', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const failResult: RotationResult = { ok: false, reason: 'synth error' };

    await handleModelSwitchOutcome({
      rotationResult: failResult,
      workerId,
      currentSessionId: 'sess-1',
      desiredLabel: 'claude-sonnet-4.5',
      liveLabel: () => 'claude-haiku-4.5',
      slackUserId: 'U12345',
      notify,
    });
    expect(notify).toHaveBeenCalledWith(workerId, expect.stringContaining('<@U12345>'), false);
  });
});
