/**
 * Near-duplicate message detection for the agent-to-agent / parent-redirect
 * delivery path.
 *
 * ## Why this exists (B4 in the "child runtime error leaking to UX" report)
 *
 * When a child turn is interrupted mid-flight (a wedged subprocess, a
 * cancellation, or an idle/wall-clock watchdog) the turn ends with
 * `skipFinalize` and never persists its closing text — but the inference backend
 * subprocess has already produced that text in its own session memory. On the
 * auto-retrigger / resurrection turn, `session/load` restores that memory and
 * the model, prompted with the re-aggregated user tail, RE-EMITS essentially
 * the same opening message it already sent before the interruption.
 *
 * Observed in practice: two "starting the deploy ..." intros sent about a
 * minute apart, near-identical but not byte-identical (the model rephrased the
 * second). A naive exact-match dedup would miss them, so we normalise and use a
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
 * Short messages ("ack", "got it", "progress update:") are intentionally NEVER
 * deduped — legitimate repeats of those are common and harmless.
 */

/** Minimum normalised length for a message to be eligible for dedup at all. */
export const MIN_DEDUP_LENGTH = 60;

/**
 * Character-bigram Jaccard similarity threshold above which two long messages
 * are treated as near-duplicates.
 *
 * Calibrated against observed re-emit incidents: two rephrased "starting the
 * deploy ..." intros score ~0.32, while genuinely different reports /
 * intro-vs-status pairs from the same session score <= 0.15. 0.30 sits
 * comfortably in that gap — it catches the real re-emit while leaving a wide
 * margin against false positives. We use character bigrams (not word tokens)
 * because messages may be in languages (e.g. CJK) where whitespace tokenisation
 * is unreliable without a morphological analyser.
 *
 * Conservatism note: the cost of a FALSE POSITIVE (dropping a genuinely new
 * message) is higher than a FALSE NEGATIVE, so this is deliberately combined
 * with the MIN_DEDUP_LENGTH gate (short messages — "ack", "got it" — are never
 * deduped) and the time window in `shouldSuppressDuplicateMessage`.
 */
export const SIMILARITY_THRESHOLD = 0.3;

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
  return bigramSimilarityFromNormalised(a, b) >= SIMILARITY_THRESHOLD;
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
 * the SAME short acknowledgement ("ack", "Got it, working on it.") to the
 * SAME peer, which slips straight through that short-message gate — the
 * observed "agent keeps sending the same ack" symptom.
 *
 * For acknowledgements we therefore add a deliberately NARROW guard: suppress
 * only when a normalised-IDENTICAL message was already sent (to the same
 * sender→target pair — the caller scopes `recent`) within the window. Requiring
 * an EXACT normalised match (not similarity) keeps the false-positive risk
 * minimal: "got it" vs "on it" are different strings and both pass, so a
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
