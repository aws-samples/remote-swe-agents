/**
 * Near-duplicate message detection for the agent-to-agent / parent-redirect
 * delivery path.
 *
 * ## Why this exists
 *
 * When a child turn is interrupted mid-flight (a wedged kiro-cli subprocess, a
 * cancellation, or an idle/wall-clock watchdog) the turn ends with
 * `skipFinalize` and never persists its closing text — but the kiro-cli ACP
 * subprocess has already produced that text in its own session memory. On the
 * auto-retrigger / resurrection turn, `session/load` restores that memory and
 * the model, prompted with the re-aggregated user tail, RE-EMITS essentially
 * the same opening message it already sent before the interruption.
 *
 * Observed live: two "starting the deployment now …" intros sent ~62s apart,
 * near-identical but not byte-identical (the model rephrased the second). A naive exact-match dedup would miss them, so we normalise and use a
 * conservative prefix/length heuristic.
 *
 * ## Conservatism contract
 *
 * Per product guidance the cost of a FALSE POSITIVE (suppressing a genuinely
 * new message) is much higher than a FALSE NEGATIVE (letting a duplicate
 * through). So this predicate only fires when ALL of:
 *   - both messages are non-trivial (>= MIN_DEDUP_LENGTH normalised chars), and
 *   - the previous message was sent within `windowMs`, and
 *   - the normalised texts are either identical OR share a long identical
 *     leading prefix (>= PREFIX_MATCH_LENGTH chars).
 * Short messages ("ack", "了解です", "status update:") are intentionally NEVER
 * deduped — legitimate repeats of those are common and harmless.
 */

/** Minimum normalised length for a message to be eligible for dedup at all. */
export const MIN_DEDUP_LENGTH = 60;

/**
 * Character-bigram Jaccard similarity threshold: a candidate must score AT
 * LEAST this against a prior to even be *considered* a near-duplicate. It is a
 * necessary (not sufficient) condition — {@link isNearDuplicateMessage} also
 * applies the {@link NOVELTY_VETO_THRESHOLD} veto on top, so clearing this bar
 * alone does NOT mean a fold.
 *
 * 0.30 was chosen against genuinely-different report / intro-vs-status pairs
 * from a live incident, which score ≤ 0.15, leaving a wide margin below it. We use character bigrams (not word tokens) because the messages are
 * Japanese, where whitespace tokenisation is unreliable without a
 * morphological analyser.
 *
 * NOTE on the shared-preamble effect (why the novelty veto exists): two
 * messages that share only a fixed preamble/closer but differ in the middle
 * can still clear this bar purely on the shared boilerplate. e.g. the older
 * "starting the deployment now …" intro pair scores ~0.32–0.41 here yet carries
 * genuinely different specifics (branch/stack names) — novelty ~0.49 — so it is
 * now (correctly) NOT folded. Only messages that clear this similarity bar AND
 * are below the novelty veto (identical / lightly-rephrased re-emits) are
 * treated as duplicates.
 *
 * Conservatism note: the cost of a FALSE POSITIVE (dropping a genuinely new
 * message) is higher than a FALSE NEGATIVE, so this is deliberately combined
 * with the MIN_DEDUP_LENGTH gate (short messages are never deduped), the
 * novelty veto, and the time window in
 * `shouldSuppressDuplicateMessage`.
 */
export const SIMILARITY_THRESHOLD = 0.3;

/**
 * Novelty veto threshold (fraction of the CANDIDATE's character bigrams that
 * do NOT appear in the prior message). Even when overall similarity clears
 * {@link SIMILARITY_THRESHOLD}, the candidate is NOT treated as a duplicate
 * when this much of it is genuinely new content — this is what distinguishes a
 * true re-emit (the model resending the same message, possibly rephrased) from
 * a legitimately new reply that merely reuses a fixed preamble.
 *
 * ## Why this exists (dedup false positive found in E2E testing)
 *
 * The observed incident: two consecutive `sendMessageToUser` bodies shared a
 * long fixed preamble (a memorised passphrase / project / model line and a
 * fixed closing line), but the SECOND carried genuinely new substance in
 * the middle — a user-requested calculation result (`17 + 25 = 42`) and a
 * newly-learned fact. Whole-string bigram Jaccard was dominated by the shared
 * boilerplate (~0.61), so the near-duplicate heuristic fired and the legitimate
 * reply was suppressed (never rendered / never persisted). That reply was NOT
 * an auto-retrigger re-emit at all — the dedup simply matched a similar prior.
 *
 * ## Calibration (measured on the real incident texts + re-emit fixtures)
 *   - false-positive (legit new reply w/ shared preamble): novelty ≈ 0.32
 *   - rephrased re-emit (the live intro pair above):     novelty ≈ 0.17
 *   - exact re-emit:                                        novelty = 0.00
 * 0.25 sits in the gap: it vetoes the false positive while still folding
 * exact + rephrased re-emits (the heuristic's actual target).
 */
export const NOVELTY_VETO_THRESHOLD = 0.25;

/** Default look-back window for treating a prior message as a possible re-emit. */
export const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 min

/**
 * Normalise a message for comparison: trim, lowercase, and collapse all
 * whitespace runs to a single space. Lowercasing keeps the heuristic robust to
 * trivial case changes; whitespace collapsing absorbs the model re-flowing
 * line breaks on the re-emit.
 */
export const normalizeForDedup = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** Build the set of adjacent character bigrams of a normalised string. */
const characterBigrams = (normalised: string): Set<string> => {
  const grams = new Set<string>();
  for (let i = 0; i < normalised.length - 1; i++) {
    grams.add(normalised.slice(i, i + 2));
  }
  return grams;
};

/**
 * Character-bigram Jaccard similarity of two ALREADY-NORMALISED strings in
 * [0, 1]. Internal helper: callers must pass strings that have already been run
 * through `normalizeForDedup`. Factored out so the public entry points can
 * normalise each input exactly once (the old code normalised in
 * `isNearDuplicateMessage` and AGAIN inside `bigramSimilarity` — idempotent but
 * wasted work on every outgoing message).
 */
const bigramSimilarityFromNormalised = (na: string, nb: string): number => {
  if (na === nb) return 1;
  const A = characterBigrams(na);
  const B = characterBigrams(nb);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const g of A) if (B.has(g)) intersection++;
  return intersection / (A.size + B.size - intersection);
};

/**
 * Character-bigram Jaccard similarity of two RAW strings in [0, 1]. Normalises
 * each input once, then delegates to the shared `*FromNormalised` core.
 * Exported for unit testing / threshold calibration. Returns 1 for two
 * identical single-character strings (no bigrams) as a degenerate convenience,
 * though in practice the MIN_DEDUP_LENGTH gate means we only ever compare long
 * strings.
 */
export const bigramSimilarity = (a: string, b: string): number =>
  bigramSimilarityFromNormalised(normalizeForDedup(a), normalizeForDedup(b));

/**
 * Fraction of `candidate`'s character bigrams that do NOT appear in `prior`
 * (both ALREADY-NORMALISED), in [0, 1]. High when the candidate introduces a
 * lot of content the prior lacked — i.e. it is a genuinely new message rather
 * than a re-emit. Returns 0 for an empty candidate (no bigrams → nothing new).
 */
const candidateNoveltyFromNormalised = (candidate: string, prior: string): number => {
  const C = characterBigrams(candidate);
  if (C.size === 0) return 0;
  const P = characterBigrams(prior);
  let novel = 0;
  for (const g of C) if (!P.has(g)) novel++;
  return novel / C.size;
};

/**
 * Fraction of `candidate`'s character bigrams absent from `prior`, in [0, 1].
 * Normalises each input once. Exported for unit testing / threshold
 * calibration. See {@link NOVELTY_VETO_THRESHOLD}.
 */
export const candidateNovelty = (candidate: string, prior: string): number =>
  candidateNoveltyFromNormalised(normalizeForDedup(candidate), normalizeForDedup(prior));

/**
 * Returns true when `candidate` is a conservative near-duplicate of
 * `previous` (e.g. a resurrection re-emit of the same intro). Pure + exported
 * so the dedup decision is unit-testable in isolation from DynamoDB.
 *
 * Each input is normalised exactly once here and the normalised forms are
 * threaded into the bigram core (`bigramSimilarityFromNormalised`) to avoid a
 * redundant second normalisation pass.
 */
export const isNearDuplicateMessage = (candidate: string, previous: string): boolean => {
  const a = normalizeForDedup(candidate);
  const b = normalizeForDedup(previous);
  // Never dedup trivial / short messages — legitimate repeats are common.
  if (a.length < MIN_DEDUP_LENGTH || b.length < MIN_DEDUP_LENGTH) return false;
  if (a === b) return true;
  if (bigramSimilarityFromNormalised(a, b) < SIMILARITY_THRESHOLD) return false;
  // Similarity cleared the bar, but a shared fixed preamble can inflate it
  // while the candidate actually carries substantial NEW content (the observed
  // false positive: a memorised preamble + a fresh calculation result). If the
  // candidate is meaningfully novel relative to the prior, treat it as a new
  // message, not a re-emit. A true re-emit (identical or merely rephrased) has
  // low novelty and still folds. See {@link NOVELTY_VETO_THRESHOLD}.
  if (candidateNoveltyFromNormalised(a, b) >= NOVELTY_VETO_THRESHOLD) return false;
  return true;
};

/** A prior message considered for dedup: its raw text and write timestamp (ms). */
export interface RecentMessageForDedup {
  message: string;
  timestampMs: number;
}

/**
 * Decide whether `candidate` should be suppressed as a near-duplicate of any
 * message in `recent` that was written within `windowMs` of `nowMs`. Pure so
 * the windowing + similarity logic can be unit-tested without DynamoDB.
 */
export const shouldSuppressDuplicateMessage = (
  candidate: string,
  recent: RecentMessageForDedup[],
  nowMs: number,
  windowMs: number = DEFAULT_DEDUP_WINDOW_MS
): boolean => {
  for (const prev of recent) {
    if (nowMs - prev.timestampMs > windowMs) continue;
    if (prev.timestampMs > nowMs) continue;
    if (isNearDuplicateMessage(candidate, prev.message)) return true;
  }
  return false;
};

/**
 * Acknowledgement-specific EXACT-duplicate suppression.
 *
 * The general near-duplicate heuristic ({@link shouldSuppressDuplicateMessage})
 * intentionally NEVER dedups messages shorter than {@link MIN_DEDUP_LENGTH},
 * because legitimate short repeats are common and the bigram similarity is
 * unreliable on tiny strings. But an auto-retrigger re-runs a turn and re-emits
 * the SAME short acknowledgement ("了解です", "Got it, working on it.") to the
 * SAME peer, which slips straight through that short-message gate — the
 * observed "agent keeps sending the same ack" symptom.
 *
 * For acknowledgements we therefore add a deliberately NARROW guard: suppress
 * only when a normalised-IDENTICAL message was already sent (to the same
 * sender→target pair — the caller scopes `recent`) within the window. Requiring
 * an EXACT normalised match (not similarity) keeps the false-positive risk
 * minimal: "了解です" vs "進めます" are different strings and both pass, so a
 * genuinely different ack is never dropped. Only a verbatim repeat inside the
 * window — the retrigger signature — is folded.
 *
 * Callers MUST gate this on `acknowledge === true`; non-ack short messages keep
 * their existing (non-deduped) behaviour so intentional short repeats survive.
 */
export const shouldSuppressDuplicateAck = (
  candidate: string,
  recent: RecentMessageForDedup[],
  nowMs: number,
  windowMs: number = DEFAULT_DEDUP_WINDOW_MS
): boolean => {
  const a = normalizeForDedup(candidate);
  if (a.length === 0) return false;
  for (const prev of recent) {
    if (nowMs - prev.timestampMs > windowMs) continue;
    if (prev.timestampMs > nowMs) continue;
    if (normalizeForDedup(prev.message) === a) return true;
  }
  return false;
};
