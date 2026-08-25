/**
 * Deterministic output-layer filters for three categories of low-value
 * end-of-turn text that the model keeps emitting despite repeated prompt
 * guidance (the prompt approach failed across ~21 PRs, so this is a
 * mechanical, prompt-independent backstop applied at the single delivery
 * choke-point — `orchestrator.finalizeTurn`):
 *
 *   A-1 (cross-turn rehash): the end-of-turn text restates — verbatim or as a
 *       paraphrased summary — something this session ALREADY delivered/sent
 *       within the dedup window (userDeliveryLog + communicationLog + this
 *       turn's send-tool `toolUse`).
 *   A-2 (self-narration after send): this turn called a send/report tool and
 *       the end-of-turn text near-duplicates that tool's `message` argument
 *       ("I sent …", "I reported X to them").
 *   A-3 (no-information wake-up monologue): a turn woken by a timer /
 *       agentMessage / systemRetrigger (NOT a real user message) that ran NO
 *       new work tool, whose end-of-turn text is internal monologue / meta
 *       scaffolding ("Silent terminate.", "Routine progress …",
 *       "Already acknowledged …", "(no new information, so silent terminate)").
 *
 * ## Conservatism contract (shared with message-dedup.ts)
 *
 * A FALSE POSITIVE (dropping a genuinely new report) is far worse than a FALSE
 * NEGATIVE (letting a duplicate through). Therefore:
 *   - A-1/A-2 reuse the calibrated near-duplicate heuristic and only ADD a
 *     containment ("paraphrased summary") signal, both gated by a minimum
 *     length.
 *   - A-3 makes the STRUCTURAL gate the necessary condition: it can only fire
 *     when the trigger was non-user AND the turn produced zero new work-tool
 *     activity. The text-pattern match is a secondary, subordinate condition.
 *     A normal report — which is produced on a turn that ran real work tools —
 *     is excluded by the structural gate regardless of vocabulary overlap, so
 *     legitimate progress reports are never dropped even if they share words
 *     with the (deliberately minimal) monologue marker set.
 *
 * The module is side-effect-free, has no IO, and does not depend on any AWS
 * SDK, so the decision logic is unit-testable in isolation from DynamoDB and
 * can be imported from any package in the monorepo.
 */

import { normalizeForDedup, isNearDuplicateMessage, bigramSimilarity, RecentMessageForDedup } from './message-dedup';

/**
 * Minimum normalised length for the rehash containment signal to be eligible.
 *
 * The general near-duplicate gate (`MIN_DEDUP_LENGTH = 60`) is deliberately
 * high because the bigram Jaccard similarity is unreliable on short strings.
 * But a cross-turn REHASH is frequently a *condensed* paraphrase — strictly
 * shorter than the original it summarises — so the 60-char gate lets the most
 * common rehash slip through. The containment signal tolerates the asymmetry
 * (it measures how much of the candidate is contained in the prior, not their
 * symmetric overlap), so we relax the length gate to 20 normalised chars for
 * THIS path only. Below 20 chars even containment is noisy, so we stop.
 */
export const MIN_REHASH_LENGTH = 20;

/**
 * Character-bigram containment threshold above which `candidate` is treated as
 * a paraphrased summary / restatement of `prior`.
 *
 * Containment = |bigrams(candidate) ∩ bigrams(prior)| / |bigrams(candidate)|,
 * i.e. the fraction of the candidate's bigrams that also appear in the prior.
 * Unlike Jaccard similarity this is ASYMMETRIC: a short condensed restatement
 * whose every fragment came from the longer original scores ~1.0, while the
 * reverse (prior contained in candidate) does NOT, which is exactly what a
 * rehash looks like (new turn says less, all of it lifted from the old turn).
 *
 * Calibrated against real rephrase pairs: a genuine paraphrased restatement
 * scores 0.76–0.94 (the model reuses almost all of its own bigrams from the
 * source, only inserting a few new connective particles), while a genuinely-new
 * message that merely shares topic vocabulary scores ≤ 0.18. 0.65 sits in the
 * wide gap with a large margin on BOTH sides — it catches the real rehash while
 * leaving genuine new reports far below the bar. Combined with MIN_REHASH_LENGTH
 * this stays firmly on the conservative side.
 */
export const REHASH_CONTAINMENT_THRESHOLD = 0.65;

/**
 * Symmetric character-bigram Jaccard threshold for the relaxed-length rehash /
 * self-narration path.
 *
 * The general near-duplicate gate (`isNearDuplicateMessage`) requires BOTH
 * sides to be ≥ `MIN_DEDUP_LENGTH` (60). But A-2 self-narration ("I sent that …")
 * is frequently a SAME-LENGTH restatement well under 60 chars — too short for
 * that gate, and too long-ratio for the containment path (it is not a
 * condensation). It is, however, strongly symmetrically similar to the text it
 * narrates. So we add a relaxed symmetric path: both sides only need to clear
 * `MIN_REHASH_LENGTH` (20) and the Jaccard similarity must be high.
 *
 * Set to 0.70: calibration shows A-2 narration pairs at ~0.79, while the W-1
 * "conditional → similarly-long achievement report" false positives sit at
 * 0.53–0.59. 0.70 separates them with margin — it catches the narration while
 * leaving genuine same-length achievement reports through.
 */
export const REHASH_SIMILARITY_THRESHOLD = 0.7;

/**
 * Maximum candidate/prior length ratio for the containment signal to fire.
 *
 * A genuine rehash is a CONDENSATION — the new turn says LESS, lifting its
 * wording from the longer original. So if the candidate is nearly as long as
 * (or longer than) the prior, it is not a summary and the high containment
 * score is coincidental rather than a restatement.
 *
 * This guards the "conditional statement → similarly-long achievement report"
 * false positive: prior "will deploy to prod once all E2E tests pass" vs
 * candidate "deployed to prod because all E2E tests passed" scores ~0.76
 * containment but the candidate is a genuine NEW achievement (the condition was
 * met), almost the same length as the condition — dropping it would silence a
 * real report, the
 * single worst failure mode. Requiring the candidate to be meaningfully shorter
 * (≤ 85% of the prior) lets such same-length achievement reports through while
 * still catching true condensed restatements (which run 0.5–0.6 of the source
 * length in the calibration set).
 */
export const REHASH_MAX_LENGTH_RATIO = 0.85;

/** Build the set of adjacent character bigrams of a normalised string. */
const characterBigrams = (normalised: string): Set<string> => {
  const grams = new Set<string>();
  for (let i = 0; i < normalised.length - 1; i++) {
    grams.add(normalised.slice(i, i + 2));
  }
  return grams;
};

/**
 * Character-bigram containment of `candidate` in `prior`, in [0, 1]:
 * the fraction of the candidate's bigrams that also occur in the prior.
 * Language-independent (operates on raw characters), so it works for Japanese
 * without a morphological analyser. Exported for unit testing / calibration.
 *
 * Returns 0 when either side has no bigrams (degenerate / single char), which
 * keeps trivially-short inputs from ever reaching the threshold.
 */
export const containmentScore = (candidate: string, prior: string): number => {
  const a = characterBigrams(normalizeForDedup(candidate));
  const b = characterBigrams(normalizeForDedup(prior));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const g of a) if (b.has(g)) intersection++;
  return intersection / a.size;
};

/**
 * True when `candidate` is a paraphrased restatement / condensed summary of
 * `prior` — the A-1/A-2 "rehash" signal that the symmetric near-duplicate
 * heuristic misses because the rehash is shorter than its source.
 *
 * Gated by MIN_REHASH_LENGTH on the candidate; the prior may be any length
 * (a long original summarised into a short rehash is the target case).
 */
export const isRehashContainment = (candidate: string, prior: string): boolean => {
  const c = normalizeForDedup(candidate);
  if (c.length < MIN_REHASH_LENGTH) return false;
  // A rehash is a condensation: the candidate must be meaningfully SHORTER than
  // the prior it restates. A candidate that is nearly as long as (or longer
  // than) the prior is treated as new content, not a summary — this blocks the
  // "conditional statement → similarly-long achievement report" false positive.
  const p = normalizeForDedup(prior);
  if (c.length > p.length * REHASH_MAX_LENGTH_RATIO) return false;
  return containmentScore(candidate, prior) >= REHASH_CONTAINMENT_THRESHOLD;
};

/**
 * True when `candidate` is a relaxed-length symmetric near-duplicate of
 * `prior`: both sides clear MIN_REHASH_LENGTH (lower than the general
 * near-dup gate of 60) and their Jaccard similarity is high. Targets A-2
 * same-length self-narration that is too short for `isNearDuplicateMessage`
 * and not a condensation (so the containment path's length-ratio guard would
 * reject it).
 */
export const isRelaxedSymmetricRehash = (candidate: string, prior: string): boolean => {
  const a = normalizeForDedup(candidate);
  const b = normalizeForDedup(prior);
  if (a.length < MIN_REHASH_LENGTH || b.length < MIN_REHASH_LENGTH) return false;
  return bigramSimilarity(candidate, prior) >= REHASH_SIMILARITY_THRESHOLD;
};

/**
 * Decide whether `candidate` end-of-turn text duplicates (verbatim, near-dup,
 * relaxed-length symmetric near-dup, or paraphrased-summary) any message in
 * `priorMessages` — the union of this session's recent userDeliveryLog +
 * communicationLog + this turn's send-tool `toolUse` arguments. Covers BOTH
 * A-1 (cross-turn rehash) and A-2 (same-turn self-narration after a send),
 * since both reduce to "the closing text echoes something we already emitted".
 *
 * Pure so the decision is unit-testable without DynamoDB; the caller is
 * responsible for assembling `priorMessages` from the windowed DDB read.
 */
export const isRehashOrSelfNarration = (candidate: string, priorMessages: RecentMessageForDedup[]): boolean => {
  for (const prior of priorMessages) {
    if (!prior.message) continue;
    // Symmetric near-duplicate (verbatim / heavily-overlapping rephrase, ≥60).
    if (isNearDuplicateMessage(candidate, prior.message)) return true;
    // Relaxed-length symmetric near-dup (same-length self-narration, ≥20).
    if (isRelaxedSymmetricRehash(candidate, prior.message)) return true;
    // Asymmetric containment (condensed paraphrase / restatement).
    if (isRehashContainment(candidate, prior.message)) return true;
  }
  return false;
};

/**
 * STRONG internal-monologue markers — phrases that essentially never appear in
 * a legitimate, information-bearing report and therefore may fire the A-3
 * pattern condition ON THEIR OWN (still subject to the structural gate).
 *
 * Predominantly English meta phrases observed leaking on send-zero wake-up
 * turns, plus a deliberately MINIMAL set of high-confidence self-memo markers
 * in other languages (e.g. Japanese) — these are FUNCTIONAL detection literals,
 * not example text: the filter must recognise monologue emitted in the agent's
 * working language, so the non-ASCII markers below are intentionally retained.
 */
export const STRONG_MONOLOGUE_RE =
  /silent terminate|no new information|already acknowledg|routine progress|monitor re-?armed|duplicate (?:of|with).*(?:no new|in-flight)|wake-?up turn|ターン終了|無情報|報告済み[^。]*待ち|既に対応済み[—-]|(?<![がの])待機中にゃ(?![けが])|待機してて|スコープ[^。]*待ち|レビュー[^。]*待[ちつ]|指摘[^。]*待[ちつ]|それまで待機/i;

/**
 * WEAK internal-monologue markers — phrases that DO occur in genuine reports
 * ("…, no decision needed for now, but deploy finished at 04:30"). On their own
 * these are NOT sufficient to suppress, because a real information-bearing
 * end-of-turn can legitimately contain them — silencing it would drop new
 * information, the worst failure mode. They only contribute when a STRONG
 * marker is also present (i.e. the text is already clearly monologue).
 *
 * Kept as a separate signal precisely so "weak marker + genuinely new
 * information" is delivered (see the false-positive guard in the tests).
 */
export const WEAK_MONOLOGUE_RE = /no decision needed|nothing (?:new )?to (?:add|report)/i;

/**
 * True when `text` matches the internal-monologue pattern. Only a STRONG
 * marker can make this fire. A WEAK marker on its own (e.g. "no decision
 * needed") is deliberately NOT sufficient — a genuine information-bearing
 * report can legitimately contain it, and silencing such a report would drop
 * new information (the worst failure mode). Weak markers therefore only ever
 * co-occur with strong ones in real monologue, in which case the strong marker
 * already triggers the match.
 */
export const isInternalMonologue = (text: string): boolean => {
  if (!text) return false;
  return STRONG_MONOLOGUE_RE.test(text.trim());
};

/**
 * Diagnostic predicate (exported for testing): true when `text` contains a WEAK
 * marker but NO strong marker — exactly the case the A-3 filter must NOT
 * suppress on its own. Encodes the "weak marker alone is delivered" contract so
 * a regression that promotes a weak marker to a standalone trigger is caught.
 */
export const hasWeakMonologueMarkerOnly = (text: string): boolean => {
  if (!text) return false;
  const t = text.trim();
  return WEAK_MONOLOGUE_RE.test(t) && !STRONG_MONOLOGUE_RE.test(t);
};

/**
 * `messageType` values for a turn trigger that is NOT a direct user input and
 * therefore eligible for the A-3 wake-up monologue filter. A real
 * `userMessage` is intentionally EXCLUDED — a direct answer to the user must
 * always be delivered.
 */
const NON_USER_TRIGGER_TYPES = new Set<string>([
  'eventTrigger',
  'agentMessage',
  'systemRetrigger',
  'mermaidFeedback',
  'errorFeedback',
]);

/** True when the turn was woken by something other than a direct user message. */
export const isNonUserTrigger = (triggerMessageType: string | undefined): boolean =>
  NON_USER_TRIGGER_TYPES.has(triggerMessageType ?? '');

/**
 * A-3 decision. Suppress the end-of-turn text ONLY when ALL of the structural
 * gate AND the pattern condition hold:
 *
 *   1. (structural) the turn was woken by a non-user trigger, AND
 *   2. (structural) the turn ran NO new work tool — `hadNewWorkTool === false`
 *      — i.e. there is no fresh work substance behind the text, AND
 *   3. (pattern)    the text matches the internal-monologue marker set.
 *
 * Conditions 1+2 are the necessary structural gate: a legitimate report is
 * produced on a turn that did real work (`hadNewWorkTool === true`) and is
 * therefore excluded here regardless of its wording. Only a send-zero,
 * work-zero wake-up whose text is pure monologue is dropped.
 *
 * Pure: the caller supplies the structural facts (trigger type, whether any
 * non-send/non-report tool ran this turn).
 */
export const shouldSuppressWakeupMonologue = (opts: {
  triggerMessageType: string | undefined;
  hadNewWorkTool: boolean;
  text: string;
}): boolean => {
  const { triggerMessageType, hadNewWorkTool, text } = opts;
  if (!isNonUserTrigger(triggerMessageType)) return false;
  if (hadNewWorkTool) return false;
  return isInternalMonologue(text);
};

/**
 * Tool names that do NOT count as "new work substance" for the A-3 structural
 * gate: the send/report family (the very tools whose use, followed by a
 * narrating end-of-turn text, IS the symptom), the no-op session-control tools,
 * and the metacognitive / housekeeping tools that produce no externally-visible
 * work.
 *
 * `think` is the critical entry here: an agent almost always calls `think`
 * before emitting a wake-up monologue, and `think` IS persisted as a `toolUse`
 * history item (see the agent loop — "every other tool (shell / file /
 * think / ...) always persists+emits unchanged"). If `think` counted as work,
 * the A-3 structural gate would stand down on essentially every real monologue
 * turn and the filter would never fire in production. The title/todo
 * housekeeping tools are included for the same reason: updating a title or todo
 * list is not the kind of "new milestone" whose existence should keep a
 * no-information monologue alive.
 *
 * Any tool OUTSIDE this set executing in the turn means real work happened, so
 * the wake-up monologue filter must stand down.
 */
export const NON_WORK_TOOL_NAMES = new Set<string>([
  'sendMessageToUser',
  'sendMessageToUserIfNecessary',
  'sendFileToUser',
  'sendMessageToAgent',
  'acknowledgeAgent',
  'completeSession',
  'think',
  'updateSessionTitle',
  'todoInit',
  'todoUpdate',
]);

/** True when at least one tool OUTSIDE {@link NON_WORK_TOOL_NAMES} ran this turn. */
export const hadNewWorkTool = (toolNamesThisTurn: Iterable<string>): boolean => {
  for (const name of toolNamesThisTurn) {
    if (!NON_WORK_TOOL_NAMES.has(name)) return true;
  }
  return false;
};
