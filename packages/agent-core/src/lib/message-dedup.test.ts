import { describe, expect, test } from 'vitest';
import {
  normalizeForDedup,
  isNearDuplicateMessage,
  shouldSuppressDuplicateMessage,
  bigramSimilarity,
  MIN_DEDUP_LENGTH,
  SIMILARITY_THRESHOLD,
  DEFAULT_DEDUP_WINDOW_MS,
  shouldSuppressDuplicateAck,
} from './message-dedup';

// ---------------------------------------------------------------------------
// B4 (resurrection re-emit duplication): a child turn interrupted mid-flight
// re-runs on auto-retrigger and re-emits essentially the same intro it already
// sent. Observed in practice: two near-identical intro messages a minute or so
// apart, sharing a prefix but rephrased in the tail. These tests pin the
// conservative dedup heuristic: near-dups are caught, genuinely different or
// short messages are NOT.

describe('normalizeForDedup', () => {
  test('trims, lowercases and collapses whitespace', () => {
    expect(normalizeForDedup('  Hello   \n World  ')).toBe('hello world');
  });
});

describe('isNearDuplicateMessage', () => {
  // A representative near-duplicate pair (truncated to the divergence point),
  // confirming the rephrased tail still trips the prefix heuristic.
  const introA =
    'Got it, starting the deploy for the test environment now. I will clone the repo, check out the branch, run the diff and then deploy. I will report the stack name and URL once it is done.';
  const introB =
    'Got it, starting the deploy for the test environment now. I will check out the target branch and deploy it under the test stack name. I will report back on success or failure.';

  test('REPRO: the two resurrection intros are detected as near-duplicates', () => {
    expect(isNearDuplicateMessage(introA, introB)).toBe(true);
  });

  test('calibration: real dup pair scores above threshold, different pairs below', () => {
    const status =
      'Root cause found: an expired auth token broke the nightly sync. Fixed the refresh path, added a regression case, pipeline is green again.';
    // Real duplicate pair sits above the threshold...
    expect(bigramSimilarity(introA, introB)).toBeGreaterThan(SIMILARITY_THRESHOLD);
    // ...while an intro vs an unrelated status report sits clearly below it,
    // confirming the gap that makes the threshold safe.
    expect(bigramSimilarity(introA, status)).toBeLessThan(SIMILARITY_THRESHOLD);
    expect(bigramSimilarity(introB, status)).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  test('exact (normalised) match is a duplicate', () => {
    const m = 'x'.repeat(MIN_DEDUP_LENGTH + 10);
    expect(isNearDuplicateMessage(m, m)).toBe(true);
    expect(isNearDuplicateMessage(`  ${m}  `, m.toUpperCase())).toBe(true);
  });

  test('short messages are NEVER deduped (conservative: legitimate repeats)', () => {
    expect(isNearDuplicateMessage('ack', 'ack')).toBe(false);
    expect(isNearDuplicateMessage('got it', 'got it')).toBe(false);
    expect(isNearDuplicateMessage('progress update:', 'progress update:')).toBe(false);
  });

  test('two genuinely different long reports that diverge early are NOT deduped', () => {
    const a = 'Step 0 status check is complete. Reporting the status of all four stacks in a list. ' + 'A'.repeat(40);
    const b = 'Merge is complete. Fast-forwarded into main and pushed, so moving on to deploy. ' + 'B'.repeat(40);
    expect(isNearDuplicateMessage(a, b)).toBe(false);
  });
});

describe('shouldSuppressDuplicateMessage (windowing)', () => {
  const now = 1_000_000_000;
  const longMsg =
    'This is a sufficiently long completion report. The stack deploy has finished, so reporting the final state in a list. Confirmed that every step completed idempotently.';

  test('suppresses a near-duplicate written inside the window', () => {
    const recent = [{ message: longMsg, timestampMs: now - 60_000 }];
    expect(shouldSuppressDuplicateMessage(longMsg, recent, now, DEFAULT_DEDUP_WINDOW_MS)).toBe(true);
  });

  test('does NOT suppress when the prior message is outside the window', () => {
    const recent = [{ message: longMsg, timestampMs: now - (DEFAULT_DEDUP_WINDOW_MS + 1) }];
    expect(shouldSuppressDuplicateMessage(longMsg, recent, now, DEFAULT_DEDUP_WINDOW_MS)).toBe(false);
  });

  test('does NOT suppress a future-dated prior (clock skew guard)', () => {
    const recent = [{ message: longMsg, timestampMs: now + 10_000 }];
    expect(shouldSuppressDuplicateMessage(longMsg, recent, now, DEFAULT_DEDUP_WINDOW_MS)).toBe(false);
  });

  test('does NOT suppress when there is no near-duplicate', () => {
    const recent = [{ message: 'A completely different long message. ' + 'Z'.repeat(50), timestampMs: now - 1000 }];
    expect(shouldSuppressDuplicateMessage(longMsg, recent, now, DEFAULT_DEDUP_WINDOW_MS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S2: the double `normalizeForDedup` pass was removed (isNearDuplicateMessage
// normalised, then bigramSimilarity normalised again). These tests pin that
// the refactor is OUTPUT-INVARIANT: results are identical whether the input is
// raw or already normalised, and the public similarity score is unchanged.
describe('S2: normalisation is idempotent / single-pass (output invariance)', () => {
  const a =
    'Got it, starting the deploy for the test environment now. I will clone the repo, check out the branch, run the diff and then deploy.';
  const b =
    'Got it, starting the deploy for the test environment now. I will check out the target branch and deploy it under the test stack.';

  test('bigramSimilarity gives the same score for raw vs pre-normalised inputs', () => {
    const raw = bigramSimilarity(a, b);
    const pre = bigramSimilarity(normalizeForDedup(a), normalizeForDedup(b));
    // normalizeForDedup is idempotent, so a second pass must not change the score.
    expect(pre).toBe(raw);
  });

  test('similarity is symmetric and bounded in [0, 1]', () => {
    const ab = bigramSimilarity(a, b);
    const ba = bigramSimilarity(b, a);
    expect(ab).toBe(ba);
    expect(ab).toBeGreaterThanOrEqual(0);
    expect(ab).toBeLessThanOrEqual(1);
  });

  test('identical (normalised) strings still score 1', () => {
    const m = 'x'.repeat(MIN_DEDUP_LENGTH + 5);
    expect(bigramSimilarity(`  ${m}  `, m.toUpperCase())).toBe(1);
  });

  test('isNearDuplicateMessage verdict is unchanged for the real B4 pair', () => {
    expect(isNearDuplicateMessage(a, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Acknowledgement-specific EXACT-duplicate suppression. Short acks slip
// through the general near-duplicate gate (< MIN_DEDUP_LENGTH never deduped),
// so an auto-retrigger re-emits the same ack to the same peer. This guard
// folds ONLY a normalised-identical repeat within the window.
// ---------------------------------------------------------------------------
describe('shouldSuppressDuplicateAck', () => {
  const now = 1_000_000;
  const w = DEFAULT_DEDUP_WINDOW_MS;

  test('suppresses a short ack identical to a recent one (the retrigger case)', () => {
    expect(shouldSuppressDuplicateAck('got it', [{ message: 'got it', timestampMs: now - 1000 }], now, w)).toBe(true);
  });

  test('normalisation: whitespace / case differences still count as identical', () => {
    expect(
      shouldSuppressDuplicateAck(
        '  Got it, working on it.  ',
        [{ message: 'got it, working on it.', timestampMs: now - 1000 }],
        now,
        w
      )
    ).toBe(true);
  });

  test('does NOT suppress a genuinely different short ack', () => {
    expect(shouldSuppressDuplicateAck('on it', [{ message: 'got it', timestampMs: now - 1000 }], now, w)).toBe(false);
  });

  test('does NOT suppress when there is no recent ack', () => {
    expect(shouldSuppressDuplicateAck('got it', [], now, w)).toBe(false);
  });

  test('ignores acks older than the window', () => {
    expect(shouldSuppressDuplicateAck('got it', [{ message: 'got it', timestampMs: now - w - 1 }], now, w)).toBe(false);
  });

  test('only EXACT matches fire — near-but-not-identical short text passes', () => {
    // Differs by one trailing char; not an exact normalised match.
    expect(shouldSuppressDuplicateAck('got it!', [{ message: 'got it', timestampMs: now - 1000 }], now, w)).toBe(false);
  });

  test('empty / whitespace candidate is never suppressed', () => {
    expect(shouldSuppressDuplicateAck('   ', [{ message: '   ', timestampMs: now - 1000 }], now, w)).toBe(false);
  });
});
