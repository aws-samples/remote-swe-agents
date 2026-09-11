/**
 * Failure-class-aware in-turn retry ladder.
 * Exercises the REAL production decision functions (classifyKiroFailure +
 * decideRetryLadder) — no re-implementation of the policy in the test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PROMPT_SETTLE_WEDGED_ERROR } from '@remote-swe-agents/agent-core/lib';
import {
  classifyKiroFailure,
  decideRetryLadder,
  kiroRetryMaxPerClass,
  kiroRetryMaxTotal,
  emptyResponseRetryEnabled,
  parseIntEnv,
  parseBoolEnv,
  EMPTY_RESPONSE_ERROR,
  type KiroFailureClass,
} from './kiro-loop-helpers';

describe('classifyKiroFailure', () => {
  it('classifies permanent errors (validation/image) first', () => {
    expect(classifyKiroFailure('invalid_request_error: prompt too long')).toBe('permanent');
    expect(classifyKiroFailure('validation_error: bad input')).toBe('permanent');
    expect(classifyKiroFailure('Image dimensions exceed the maximum allowed')).toBe('permanent');
  });

  it('classifies the synthetic empty-response marker', () => {
    expect(classifyKiroFailure(EMPTY_RESPONSE_ERROR)).toBe('empty-response');
    expect(classifyKiroFailure(`wrapped: ${EMPTY_RESPONSE_ERROR} (details)`)).toBe('empty-response');
  });

  it('classifies process death', () => {
    expect(classifyKiroFailure('Kiro CLI process died during prompt')).toBe('process-died');
    expect(classifyKiroFailure('the subprocess process died unexpectedly')).toBe('process-died');
  });

  it('classifies busy (-32603 Prompt already in progress)', () => {
    expect(classifyKiroFailure('session/prompt failed: {"code":-32603,"message":"Prompt already in progress"}')).toBe(
      'busy'
    );
  });

  it('classifies wedged (settle timeout)', () => {
    expect(classifyKiroFailure(PROMPT_SETTLE_WEDGED_ERROR)).toBe('wedged');
    expect(classifyKiroFailure('kiro-cli prompt did not settle; subprocess wedged (recycle required)')).toBe('wedged');
  });

  it('classifies idle watchdog timeouts as idle-timeout', () => {
    expect(
      classifyKiroFailure(
        'Kiro ACP prompt idle for 600s (no agent_message_chunk, tool_call, or tool_call_update; no tool in-flight). elapsed=602s, lastActivity=600s ago'
      )
    ).toBe('idle-timeout');
    expect(classifyKiroFailure('session/prompt timed out after 900s')).toBe('idle-timeout');
  });

  it('classifies the HARD wall-clock ceiling as hard-wall (separate from idle-timeout)', () => {
    expect(
      classifyKiroFailure(
        'Kiro ACP prompt exceeded hard wall-clock ceiling of 1800s measured from turn start; interrupting in-flight work as runaway protection.'
      )
    ).toBe('hard-wall');
  });

  it('classifies everything else as unknown (still retryable)', () => {
    expect(classifyKiroFailure('session/prompt failed: {"code":-32603,"message":"Internal error"}')).toBe('unknown');
    expect(classifyKiroFailure('Connection reset by peer')).toBe('unknown');
    expect(classifyKiroFailure('ECONNREFUSED')).toBe('unknown');
    expect(classifyKiroFailure('')).toBe('unknown');
  });

  it('permanent wins over an otherwise-matching wedged/timeout substring', () => {
    // A permanent validation error that also happens to mention a timeout word
    // must still classify as permanent (permanent is checked first).
    expect(classifyKiroFailure('validation_error: request timed out validating image')).toBe('permanent');
  });
});

describe('decideRetryLadder', () => {
  const opts = { maxPerClass: 3, emptyResponseEnabled: false };

  it('permanent → never retry', () => {
    expect(decideRetryLadder('permanent', {}, opts)).toBe('permanent');
    expect(decideRetryLadder('permanent', { permanent: 5 }, opts)).toBe('permanent');
  });

  it('retries up to maxPerClass, then gives up — independent per class', () => {
    // process-died: 0,1,2 used → retry; 3 used → giveup
    expect(decideRetryLadder('process-died', {}, opts)).toBe('retry');
    expect(decideRetryLadder('process-died', { 'process-died': 2 }, opts)).toBe('retry');
    expect(decideRetryLadder('process-died', { 'process-died': 3 }, opts)).toBe('giveup');

    // wedged budget is independent of process-died's usage
    expect(decideRetryLadder('wedged', { 'process-died': 3 }, opts)).toBe('retry');
  });

  it('empty-response gives up immediately when disabled, retries when enabled', () => {
    expect(decideRetryLadder('empty-response', {}, { maxPerClass: 3, emptyResponseEnabled: false })).toBe('giveup');
    expect(decideRetryLadder('empty-response', {}, { maxPerClass: 3, emptyResponseEnabled: true })).toBe('retry');
    expect(
      decideRetryLadder('empty-response', { 'empty-response': 3 }, { maxPerClass: 3, emptyResponseEnabled: true })
    ).toBe('giveup');
  });

  it('maxPerClass=0 disables in-turn retries for every non-permanent class', () => {
    const zero = { maxPerClass: 0, emptyResponseEnabled: false };
    const classes: KiroFailureClass[] = ['process-died', 'wedged', 'busy', 'idle-timeout', 'unknown'];
    for (const c of classes) expect(decideRetryLadder(c, {}, zero)).toBe('giveup');
  });

  it('hard-wall is never retried in-turn (giveup regardless of budget)', () => {
    expect(decideRetryLadder('hard-wall', {}, opts)).toBe('giveup');
    expect(decideRetryLadder('hard-wall', { 'hard-wall': 0 }, { maxPerClass: 3, emptyResponseEnabled: false })).toBe(
      'giveup'
    );
  });

  it('total-attempt cap gives up once the sum across classes reaches maxTotal', () => {
    const withCap = { maxPerClass: 3, emptyResponseEnabled: false, maxTotal: 4 };
    // 2 process-died + 1 wedged = 3 total, wedged still has per-class room and total < 4 → retry
    expect(decideRetryLadder('wedged', { 'process-died': 2, wedged: 1 }, withCap)).toBe('retry');
    // total = 4 → giveup even though this class has per-class room
    expect(decideRetryLadder('wedged', { 'process-died': 3, wedged: 1 }, withCap)).toBe('giveup');
  });

  it('an attempt that already did tool activity is not retried in-turn (giveup)', () => {
    expect(
      decideRetryLadder('unknown', {}, { maxPerClass: 3, emptyResponseEnabled: false, toolActivityThisAttempt: true })
    ).toBe('giveup');
    // Without tool activity the same class/count retries.
    expect(
      decideRetryLadder('unknown', {}, { maxPerClass: 3, emptyResponseEnabled: false, toolActivityThisAttempt: false })
    ).toBe('retry');
  });

  it('precedence: permanent still wins over tool-activity/hard-wall/total', () => {
    expect(
      decideRetryLadder('permanent', {}, { maxPerClass: 0, emptyResponseEnabled: false, toolActivityThisAttempt: true })
    ).toBe('permanent');
  });
});

describe('retry-ladder env tunables', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('parseIntEnv falls back on unset/invalid/negative', () => {
    expect(parseIntEnv('KIRO_TEST_INT_UNSET', 7)).toBe(7);
    vi.stubEnv('KIRO_TEST_INT_UNSET', '');
    expect(parseIntEnv('KIRO_TEST_INT_UNSET', 7)).toBe(7);
    vi.stubEnv('KIRO_TEST_INT_UNSET', 'abc');
    expect(parseIntEnv('KIRO_TEST_INT_UNSET', 7)).toBe(7);
    vi.stubEnv('KIRO_TEST_INT_UNSET', '-1');
    expect(parseIntEnv('KIRO_TEST_INT_UNSET', 7)).toBe(7);
    vi.stubEnv('KIRO_TEST_INT_UNSET', '5');
    expect(parseIntEnv('KIRO_TEST_INT_UNSET', 7)).toBe(5);
  });

  it('parseBoolEnv recognises on/off forms and falls back otherwise', () => {
    expect(parseBoolEnv('KIRO_TEST_BOOL', false)).toBe(false);
    for (const t of ['1', 'true', 'on', 'YES']) {
      vi.stubEnv('KIRO_TEST_BOOL', t);
      expect(parseBoolEnv('KIRO_TEST_BOOL', false)).toBe(true);
    }
    for (const f of ['0', 'false', 'off', 'NO']) {
      vi.stubEnv('KIRO_TEST_BOOL', f);
      expect(parseBoolEnv('KIRO_TEST_BOOL', true)).toBe(false);
    }
    vi.stubEnv('KIRO_TEST_BOOL', 'maybe');
    expect(parseBoolEnv('KIRO_TEST_BOOL', true)).toBe(true);
  });

  it('kiroRetryMaxPerClass default 3, override honored', () => {
    expect(kiroRetryMaxPerClass()).toBe(3);
    vi.stubEnv('KIRO_ACP_RETRY_MAX_PER_CLASS', '5');
    expect(kiroRetryMaxPerClass()).toBe(5);
  });

  it('kiroRetryMaxTotal default 6, override honored', () => {
    expect(kiroRetryMaxTotal()).toBe(6);
    vi.stubEnv('KIRO_ACP_RETRY_MAX_TOTAL', '10');
    expect(kiroRetryMaxTotal()).toBe(10);
  });

  it('emptyResponseRetryEnabled default OFF, override honored', () => {
    expect(emptyResponseRetryEnabled()).toBe(false);
    vi.stubEnv('KIRO_ACP_RETRY_EMPTY_RESPONSE', 'on');
    expect(emptyResponseRetryEnabled()).toBe(true);
  });
});
