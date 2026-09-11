import { describe, expect, test } from 'vitest';
import type { RecentMessageForDedup } from './message-dedup';
import {
  containmentScore,
  isRehashContainment,
  isRehashOrSelfNarration,
  isInternalMonologue,
  hasWeakMonologueMarkerOnly,
  isNonUserTrigger,
  shouldSuppressWakeupMonologue,
  hadNewWorkTool,
  MIN_REHASH_LENGTH,
  REHASH_CONTAINMENT_THRESHOLD,
} from './self-narration-filter';

// Send-zero internal-monologue leaks, synthesised from live observations.
// Every one of these was emitted as end-of-turn text on a timer/ack wake-up
// turn that called NO send tool — the A-3 target. (Codenames replaced with
// neutral placeholders; the marker phrases are what the detector keys on.)
//
// NOTE on fixtures: production traffic is Japanese, so several fixtures below
// are synthetic JAPANESE texts — the CJK content is a functional requirement
// of the marker set and the bigram calibration, not incidental.
const A3_FIXTURES = [
  'Routine progress report — worker B produced the scaffold with honest caveats, awaiting the artifact drop. No decision needed. Silent terminate.',
  "Already acknowledged worker B's status; this is a duplicate of the same in-flight report with no new information. Silent terminate.",
  'Silent — worker B confirmed alive at 03:37 with a 03:51 self-wake to verify the DONE marker; no new milestone for the user yet, monitor re-armed to catch the landed result or escalate if the self-wake cycle breaks.',
  'Already acknowledged this exact milestone and re-armed the monitor to 11:30Z; this is a duplicate with no new information. Silent terminate.',
  'Routine progress — worker B confirmed the 64x64 asset resolution from the manifest, scaffold proceeding, awaiting the 11:30Z artifact for the next compile step. No decision needed, monitor already armed for 11:30Z. Silent terminate.',
];

const recent = (message: string, timestampMs = 1000): RecentMessageForDedup => ({ message, timestampMs });

describe('containmentScore', () => {
  test('a condensed paraphrase of a prior scores high', () => {
    const prior =
      'デプロイを開始します。まずはCDKのスタックを確認して、変更点を洗い出してから順番に適用していきます。差分が出たら都度報告します。';
    const rehash = 'CDKスタックを確認して変更点を洗い出してから順番に適用していきます。';
    expect(containmentScore(rehash, prior)).toBeGreaterThanOrEqual(0.65);
  });

  test('an unrelated message scores low even if same topic domain', () => {
    const prior = 'CDKのスタックを確認して変更点を洗い出します。';
    const other = 'E2Eテストが3件失敗したのでログを貼ります。原因はCognitoのトークン期限切れでした。';
    expect(containmentScore(other, prior)).toBeLessThan(0.65);
  });

  // BOUNDARY: a candidate whose containment lands exactly on the threshold
  // (0.65) is treated as a rehash (>= comparison), and one just below is not.
  test('BOUNDARY: containment exactly at threshold is a rehash, just below is not', () => {
    const prior = 'abcdefghijklmn0123456789()';
    const atThreshold = 'abcdefghijklmnopqrstu'; // 14/20 shared bigrams over 20 → 0.65
    expect(containmentScore(atThreshold, prior)).toBeCloseTo(0.65, 5);
    expect(isRehashContainment(atThreshold, prior)).toBe(true);

    const belowThreshold = 'abcdefghijklm0pqrstuvwxy'; // fewer shared bigrams
    expect(containmentScore(belowThreshold, prior)).toBeLessThan(0.65);
    expect(isRehashContainment(belowThreshold, prior)).toBe(false);
  });

  // BOUNDARY: MIN_REHASH_LENGTH is inclusive — a candidate of exactly the
  // minimum length is eligible, one char shorter is not.
  test('BOUNDARY: MIN_REHASH_LENGTH is inclusive', () => {
    const prior = 'abcdefghijklmnopqrstuvwxyz0123'; // 30 chars, fully contains both candidates
    const atMin = 'abcdefghijklmnopqrst'; // exactly 20
    const belowMin = 'abcdefghijklmnopqrs'; // 19
    expect(atMin.length).toBe(MIN_REHASH_LENGTH);
    expect(belowMin.length).toBe(MIN_REHASH_LENGTH - 1);
    expect(isRehashContainment(atMin, prior)).toBe(true);
    expect(isRehashContainment(belowMin, prior)).toBe(false);
  });
});

describe('isRehashContainment', () => {
  test('fires for a paraphrased summary above the length gate', () => {
    const prior =
      'バックエンドの実装が完了して、lint も typecheck も通りました。残りは E2E テストだけなので、それが緑になったら PR を上げます。';
    const rehash = 'バックエンドの実装が完了して lint も typecheck も通りました。';
    expect(isRehashContainment(rehash, prior)).toBe(true);
  });

  test('does NOT fire below MIN_REHASH_LENGTH', () => {
    const prior = 'バックエンドの実装が完了して lint も typecheck も通りました。残りは E2E だけです。';
    const tiny = '完了です';
    expect(tiny.length).toBeLessThan(MIN_REHASH_LENGTH);
    expect(isRehashContainment(tiny, prior)).toBe(false);
  });

  // FALSE-POSITIVE GUARD: a genuine achievement report that lifts wording from
  // a prior CONDITIONAL statement (and is roughly the SAME length) must NOT be
  // treated as a rehash — silencing a real "the condition was met" report is
  // the worst failure mode. The length-ratio guard (candidate must be
  // meaningfully shorter than the prior) lets it through despite high
  // containment.
  test('FALSE-POSITIVE GUARD: similarly-long achievement report of a prior conditional is NOT a rehash', () => {
    const condition = 'E2Eテストが全部通ったら本番にデプロイする予定です。';
    const achievement = 'E2Eテストが全部通ったので本番にデプロイしました。';
    // High containment, but the achievement is ~same length as the condition.
    expect(containmentScore(achievement, condition)).toBeGreaterThanOrEqual(REHASH_CONTAINMENT_THRESHOLD);
    expect(isRehashContainment(achievement, condition)).toBe(false);
  });

  test('BOUNDARY: a genuine condensed rehash (≤85% length) still fires', () => {
    // A true rehash is a condensation, well under the length-ratio guard.
    const prior =
      'バックエンドの実装が完了して、lint も typecheck も通りました。残りは E2E テストだけなので、それが緑になったら PR を上げます。';
    const rehash = 'バックエンドの実装が完了して lint も typecheck も通りました。';
    expect(isRehashContainment(rehash, prior)).toBe(true);
  });
});

describe('isRehashOrSelfNarration (A-1 / A-2)', () => {
  test('A-2: end-of-turn text narrating a just-sent message is suppressed', () => {
    const sent = '進捗報告: バックエンド実装が完了して lint/typecheck 通過、残りは E2E テストだけです。';
    const narration = 'バックエンド実装が完了して lint/typecheck 通過、残りは E2E テストだけと送りました。';
    expect(isRehashOrSelfNarration(narration, [recent(sent)])).toBe(true);
  });

  test('A-1: a cross-turn paraphrased restatement is suppressed', () => {
    const lastTurn =
      'Backend: 実装完了, DevOps: デプロイ待ち, E2E: 3件中2件パス。残課題はCognitoトークン期限のテストだけです。';
    const rehash = 'Backend実装完了、DevOpsデプロイ待ち、E2Eは3件中2件パスです。';
    expect(isRehashOrSelfNarration(rehash, [recent(lastTurn)])).toBe(true);
  });

  test('FALSE-POSITIVE GUARD: a genuinely new report is NOT suppressed', () => {
    const lastTurn = 'Backend: 実装完了, DevOps: デプロイ待ち, E2E: 3件中2件パスです。';
    const newInfo =
      'E2Eの残り1件、原因が判明しました。Cognitoのトークン期限切れで、admin-set-user-password の permanent フラグ漏れでした。修正して再実行します。';
    expect(isRehashOrSelfNarration(newInfo, [recent(lastTurn)])).toBe(false);
  });

  test('FALSE-POSITIVE GUARD: empty prior list never suppresses', () => {
    expect(isRehashOrSelfNarration('内容は何であれ新規のメッセージです。これは必ず配信されます。', [])).toBe(false);
  });

  test('FALSE-POSITIVE GUARD (pipeline): conditional → similarly-long achievement report is delivered', () => {
    const condition = 'E2Eテストが全部通ったら本番にデプロイする予定です。';
    const achievement = 'E2Eテストが全部通ったので本番にデプロイしました。';
    // Neither the symmetric, relaxed-symmetric, nor the containment
    // (length-ratio guard) path fires → genuine new report passes.
    expect(isRehashOrSelfNarration(achievement, [recent(condition)])).toBe(false);
  });
});

describe('isInternalMonologue (A-3 pattern, subordinate to structural gate)', () => {
  test.each(A3_FIXTURES)('matches leaked monologue fixture: %s', (fixture) => {
    expect(isInternalMonologue(fixture)).toBe(true);
  });

  test('matches Japanese self-memo markers', () => {
    expect(isInternalMonologue('(無情報なので silent terminate)')).toBe(true);
    expect(isInternalMonologue('(既に対応済み — ターン終了)')).toBe(true);
    expect(isInternalMonologue('報告済み、worker B の結果待ちです')).toBe(true);
  });

  test('matches Japanese standby/waiting phrases (retrigger ack-loop prevention)', () => {
    expect(isInternalMonologue('待機中です、レビュー結果を待っています')).toBe(true);
    expect(isInternalMonologue('了解です、待機していてください')).toBe(true);
    expect(isInternalMonologue('スコープ確定待ちで待機中です')).toBe(true);
    expect(isInternalMonologue('レビューが返ってくるまで待ちです')).toBe(true);
    expect(isInternalMonologue('指摘待ちで待機中です')).toBe(true);
    expect(isInternalMonologue('それまで待機しています')).toBe(true);
  });

  test('does NOT match a normal Japanese progress report', () => {
    expect(
      isInternalMonologue(
        'バックエンド実装が完了しました。lint と typecheck が緑で、PR を上げました: https://example.com/pr/1'
      )
    ).toBe(false);
  });

  test('does NOT match a Japanese message with new information even if standby words appear', () => {
    expect(isInternalMonologue('レビュー指摘の修正が完了しました。27テスト全部通ったのでpushしました。')).toBe(false);
    expect(isInternalMonologue('スコープ変更が来ました。新タスクとして取り掛かります。')).toBe(false);
  });

  test('does NOT match sentences containing standby words but carrying new information (sentence-crossing guard)', () => {
    expect(isInternalMonologue('デプロイサーバーが待機中です。リクエスト受付を開始しました。')).toBe(false);
    expect(isInternalMonologue('CI待機中ですが、lintは先に通りました。')).toBe(false);
    expect(isInternalMonologue('レビュー結果が来ました。指摘1件を修正してpushしました。')).toBe(false);
    expect(isInternalMonologue('スコープが変わりました。新しいタスクに着手します。')).toBe(false);
  });

  test('does NOT match a direct factual answer', () => {
    expect(isInternalMonologue('4')).toBe(false);
    expect(isInternalMonologue('src/foo.c に実装があります。')).toBe(false);
  });

  // A WEAK marker ("no decision needed" / "nothing to report") must NOT
  // trigger on its own — a genuine report can carry it alongside new
  // information. Only strong markers fire standalone.
  test('weak marker ALONE does not match (new info delivered)', () => {
    expect(isInternalMonologue('No decision needed, but deploy finished at 04:30 and health checks are green.')).toBe(
      false
    );
    expect(isInternalMonologue('Nothing new to report on the lint front, but the E2E suite now passes 3/3.')).toBe(
      false
    );
    expect(hasWeakMonologueMarkerOnly('No decision needed, but deploy finished at 04:30.')).toBe(true);
  });

  test('weak marker CO-OCCURRING with a strong marker still matches', () => {
    // The real fixtures carry both; the strong marker is what fires.
    expect(isInternalMonologue('Routine progress. No decision needed. Silent terminate.')).toBe(true);
    expect(hasWeakMonologueMarkerOnly('Routine progress. No decision needed. Silent terminate.')).toBe(false);
  });
});

describe('isNonUserTrigger', () => {
  test('user message is NOT a non-user trigger', () => {
    expect(isNonUserTrigger('userMessage')).toBe(false);
  });
  test.each(['eventTrigger', 'agentMessage', 'systemRetrigger'])('%s is a non-user trigger', (t) => {
    expect(isNonUserTrigger(t)).toBe(true);
  });
  test('undefined trigger is treated as non-non-user (delivers)', () => {
    expect(isNonUserTrigger(undefined)).toBe(false);
  });
});

describe('hadNewWorkTool', () => {
  test('send/report/ack-only turn has no new work tool', () => {
    expect(hadNewWorkTool(['sendMessageToAgent', 'acknowledgeAgent'])).toBe(false);
    expect(hadNewWorkTool([])).toBe(false);
  });
  test('any non-send tool counts as new work', () => {
    expect(hadNewWorkTool(['executeCommand'])).toBe(true);
    expect(hadNewWorkTool(['sendMessageToUser', 'fileEditor'])).toBe(true);
  });
  // `think` (and the housekeeping tools) MUST NOT count as work, otherwise
  // the A-3 structural gate stands down on essentially every real monologue
  // turn (the agent almost always calls `think` first) and the filter never
  // fires in production.
  test('think / title / todo housekeeping tools are NOT new work', () => {
    expect(hadNewWorkTool(['think'])).toBe(false);
    expect(hadNewWorkTool(['think', 'updateSessionTitle', 'todoInit', 'todoUpdate'])).toBe(false);
    expect(hadNewWorkTool(['think', 'acknowledgeAgent'])).toBe(false);
  });
});

describe('shouldSuppressWakeupMonologue (A-3 full AND gate)', () => {
  test.each(A3_FIXTURES)('suppresses leak on a send-zero non-user wake-up: %s', (fixture) => {
    expect(
      shouldSuppressWakeupMonologue({
        triggerMessageType: 'eventTrigger',
        hadNewWorkTool: false,
        text: fixture,
      })
    ).toBe(true);
  });

  test('FALSE-POSITIVE GUARD: same monologue text on a USER turn is delivered', () => {
    // Even if the text matches the pattern, a direct user message must answer.
    expect(
      shouldSuppressWakeupMonologue({
        triggerMessageType: 'userMessage',
        hadNewWorkTool: false,
        text: A3_FIXTURES[0],
      })
    ).toBe(false);
  });

  test('FALSE-POSITIVE GUARD: a wake-up that DID real work is delivered', () => {
    // Structural gate stands down the moment real work happened this turn,
    // regardless of vocabulary overlap with the marker set.
    expect(
      shouldSuppressWakeupMonologue({
        triggerMessageType: 'agentMessage',
        hadNewWorkTool: true,
        text: 'Routine progress — but actually I just deployed and here are the new results. No decision needed.',
      })
    ).toBe(false);
  });

  test('FALSE-POSITIVE GUARD: a real new report on a send-zero wake-up (no marker) is delivered', () => {
    expect(
      shouldSuppressWakeupMonologue({
        triggerMessageType: 'eventTrigger',
        hadNewWorkTool: false,
        text: 'デプロイが完了して、ヘルスチェックも200を返しました。本番反映が完了しています。',
      })
    ).toBe(false);
  });

  // Regression at the full-gate level: a wake-up turn that called ONLY
  // `think` (the dominant real-world shape) must still be treated as
  // work-zero, so the monologue is suppressed. If `think` ever leaks back into
  // the work set this test goes red.
  test('think-only wake-up turn still fires A-3 (monologue suppressed)', () => {
    expect(
      shouldSuppressWakeupMonologue({
        triggerMessageType: 'agentMessage',
        hadNewWorkTool: hadNewWorkTool(['think']),
        text: A3_FIXTURES[1],
      })
    ).toBe(true);
  });
});
