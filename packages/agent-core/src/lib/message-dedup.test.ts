import { describe, expect, test } from 'vitest';
import {
  normalizeForDedup,
  isNearDuplicateMessage,
  shouldSuppressDuplicateMessage,
  bigramSimilarity,
  candidateNovelty,
  MIN_DEDUP_LENGTH,
  SIMILARITY_THRESHOLD,
  NOVELTY_VETO_THRESHOLD,
  DEFAULT_DEDUP_WINDOW_MS,
  shouldSuppressDuplicateAck,
} from './message-dedup';

// ---------------------------------------------------------------------------
// Resurrection re-emit duplication: a child turn interrupted mid-flight
// re-runs on auto-retrigger and re-emits essentially the same intro it already
// sent — observed live as two "starting the deployment …" intros ~62s apart,
// near-identical but rephrased in the tail. These tests pin the conservative
// dedup heuristic: near-dups are caught, genuinely different or short messages
// are NOT.
//
// NOTE on fixtures: the heuristic is character-bigram based specifically
// because production traffic is Japanese (whitespace tokenisation is
// unreliable without a morphological analyser), so these fixtures are
// synthetic JAPANESE texts modelled on the real incidents. The CJK content is
// a functional requirement of the calibration, not incidental.

describe('normalizeForDedup', () => {
  test('trims, lowercases and collapses whitespace', () => {
    expect(normalizeForDedup('  Hello   \n World  ')).toBe('hello world');
  });
});

describe('isNearDuplicateMessage', () => {
  // Modelled on the observed pair (truncated to the divergence point): a
  // shared opening/closing with genuinely different specifics in the middle.
  const introA =
    '了解です！E2Eテスト環境のデプロイを開始します。リポジトリをクローン → ブランチをチェックアウト → cdk diff → deploy の順で進めます。完了したらスタック名と URL を報告します。';
  const introB =
    '了解です！E2E テスト環境のデプロイを開始します。ブランチ fix/session-visibility をチェックアウトして、テスト用スタック TestStackA にデプロイします。完了または失敗したら報告します。';

  // BEHAVIOUR CHANGE (dedup false-positive fix): the introA/introB pair
  // shares only the opening "デプロイを開始します" preamble and a closing
  // "報告します", but their MIDDLES carry genuinely different specifics
  // (introB names a concrete branch + stack; introA is generic). Their
  // whole-string similarity only barely clears the threshold precisely
  // because of the shared preamble, while the candidate's novelty is high.
  // The novelty veto (NOVELTY_VETO_THRESHOLD) now — correctly — classifies
  // this as a NEW message rather than a re-emit. This is the same structure
  // as the observed incident (a memorised preamble + a fresh calculation
  // result), where suppressing the reply lost user-visible information.
  // Genuine re-emits (identical / lightly rephrased, LOW novelty) are still
  // folded — see the test below.
  test('shared-preamble / divergent-tail pair is NOT folded (false-positive fix)', () => {
    expect(isNearDuplicateMessage(introA, introB)).toBe(false);
    // It only cleared the similarity bar because of the shared preamble...
    expect(bigramSimilarity(introA, introB)).toBeGreaterThan(SIMILARITY_THRESHOLD);
    // ...but the candidate is substantially novel, which vetoes the fold.
    expect(candidateNovelty(introB, introA)).toBeGreaterThanOrEqual(NOVELTY_VETO_THRESHOLD);
  });

  test('REGRESSION: a genuine low-novelty rephrase re-emit is STILL folded', () => {
    // The auto-retrigger case the dedup actually targets: the model resends the
    // same message with only trivial rewording (particles, punctuation, kana).
    // Novelty stays low, so it is still treated as a duplicate.
    const a =
      'デプロイを開始します。まずはCDKのスタックを確認して、変更点を洗い出してから順番に適用していきます。差分が出たら都度報告するので安心してください。';
    const b =
      'デプロイ開始します。CDKスタックを確認して、変更点を洗い出してから順に適用していきます。差分が出たらその都度報告するので安心してください。';
    expect(bigramSimilarity(a, b)).toBeGreaterThan(SIMILARITY_THRESHOLD);
    expect(candidateNovelty(b, a)).toBeLessThan(NOVELTY_VETO_THRESHOLD);
    expect(isNearDuplicateMessage(b, a)).toBe(true);
  });

  test('calibration: similar pair scores above threshold, different pairs below', () => {
    const status =
      '進捗報告です。ステージング環境のスタックは UPDATE_COMPLETE になりました。us-east-1 側は差分がないため対応は不要です。';
    // The related intro pair sits above the threshold...
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
    expect(isNearDuplicateMessage('了解です', '了解です')).toBe(false);
    expect(isNearDuplicateMessage('進捗報告:', '進捗報告:')).toBe(false);
  });

  test('two genuinely different long reports that diverge early are NOT deduped', () => {
    const a = 'ステップ 0 の現状確認が完了しました。全 4 スタックのステータスを一覧で報告します。' + 'A'.repeat(40);
    const b =
      'マージが完了しました。fast-forward で main に取り込んで push したのでデプロイに進みます。' + 'B'.repeat(40);
    expect(isNearDuplicateMessage(a, b)).toBe(false);
  });

  // Modelled on a live E2E incident (texts synthesised). A model that had
  // memorised a fixed preamble (a passphrase / project / model line + a fixed
  // closing line) sent a NEW reply carrying a user-requested calculation
  // result (17 + 25 = 42) and a newly-learned fact. The prior message shared
  // the whole preamble, so whole-string similarity was far above the
  // threshold and the legit reply was suppressed (never rendered / never
  // persisted). The novelty veto must free it.
  test('REPRO: shared-preamble reply with new info is NOT suppressed', () => {
    const priorDelivery =
      '(1) 合言葉: 「青いカメ4051」 (2) プロジェクト名: 「シナリオ演習」\nモデル: ExampleModel-1（サンプル系）です。次のメッセージを待っています。';
    const newReply =
      '合言葉: 「青いカメ4051」／プロジェクト名: 「シナリオ演習」／モデル: ExampleModel-1（サンプル系）です。\n相棒の名前「タマ」も覚えました。17 + 25 = 42。次のメッセージを待っています。';
    // The shared preamble alone pushes similarity well above the threshold...
    expect(bigramSimilarity(newReply, priorDelivery)).toBeGreaterThan(SIMILARITY_THRESHOLD);
    // ...but the new reply's fresh content clears the novelty veto...
    expect(candidateNovelty(newReply, priorDelivery)).toBeGreaterThanOrEqual(NOVELTY_VETO_THRESHOLD);
    // ...so it is NOT treated as a re-emit (the bug: it used to be).
    expect(isNearDuplicateMessage(newReply, priorDelivery)).toBe(false);
  });
});

describe('candidateNovelty', () => {
  test('is 0 for an identical message and rises with new content', () => {
    const base = 'x'.repeat(MIN_DEDUP_LENGTH + 20);
    expect(candidateNovelty(base, base)).toBe(0);
    // A candidate that is the prior plus a big block of new chars is highly novel.
    expect(candidateNovelty(base + '新しい追加情報' + 'y'.repeat(40), base)).toBeGreaterThan(NOVELTY_VETO_THRESHOLD);
  });

  test('empty candidate has no novelty', () => {
    expect(candidateNovelty('', 'anything long enough to have bigrams here')).toBe(0);
  });
});

describe('shouldSuppressDuplicateMessage (windowing)', () => {
  const now = 1_000_000_000;
  const longMsg =
    'これは十分に長い完了報告メッセージです。スタックのデプロイが完了したので最終状態を一覧で報告します。全ての処理が冪等に完了したことを確認しました。';

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
    const recent = [{ message: 'まったく別の長いメッセージです。' + 'Z'.repeat(50), timestampMs: now - 1000 }];
    expect(shouldSuppressDuplicateMessage(longMsg, recent, now, DEFAULT_DEDUP_WINDOW_MS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The double `normalizeForDedup` pass was removed (isNearDuplicateMessage
// normalised, then bigramSimilarity normalised again). These tests pin that
// the refactor is OUTPUT-INVARIANT: results are identical whether the input is
// raw or already normalised, and the public similarity score is unchanged.
describe('normalisation is idempotent / single-pass (output invariance)', () => {
  const a =
    '了解です！E2Eテスト環境のデプロイを開始します。リポジトリをクローン → ブランチをチェックアウト → cdk diff → deploy の順で進めます。';
  const b =
    '了解です！E2E テスト環境のデプロイを開始します。ブランチをチェックアウトして、テスト用スタックにデプロイします。';

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

  test('isNearDuplicateMessage verdict is single-pass stable (raw vs pre-normalised)', () => {
    // The point of this block is OUTPUT-INVARIANCE of the single-pass
    // normalisation refactor, not the specific verdict. Assert the verdict is
    // the same whether inputs are raw or pre-normalised. (The a/b pair shares
    // a preamble but diverges in the tail, so with the novelty veto it is NOT
    // a duplicate — covered explicitly in the isNearDuplicateMessage block
    // above.)
    const raw = isNearDuplicateMessage(a, b);
    const pre = isNearDuplicateMessage(normalizeForDedup(a), normalizeForDedup(b));
    expect(pre).toBe(raw);
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
    expect(shouldSuppressDuplicateAck('了解です', [{ message: '了解です', timestampMs: now - 1000 }], now, w)).toBe(
      true
    );
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
    expect(shouldSuppressDuplicateAck('進めます', [{ message: '了解です', timestampMs: now - 1000 }], now, w)).toBe(
      false
    );
  });

  test('does NOT suppress when there is no recent ack', () => {
    expect(shouldSuppressDuplicateAck('了解です', [], now, w)).toBe(false);
  });

  test('ignores acks older than the window', () => {
    expect(shouldSuppressDuplicateAck('了解です', [{ message: '了解です', timestampMs: now - w - 1 }], now, w)).toBe(
      false
    );
  });

  test('only EXACT matches fire — near-but-not-identical short text passes', () => {
    // Differs by one trailing char; not an exact normalised match.
    expect(shouldSuppressDuplicateAck('了解です！', [{ message: '了解です', timestampMs: now - 1000 }], now, w)).toBe(
      false
    );
  });

  test('empty / whitespace candidate is never suppressed', () => {
    expect(shouldSuppressDuplicateAck('   ', [{ message: '   ', timestampMs: now - 1000 }], now, w)).toBe(false);
  });
});
