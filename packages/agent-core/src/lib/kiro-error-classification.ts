import { PROMPT_SETTLE_WEDGED_ERROR } from './kiro-acp-types';

/**
 * Canonical, user-facing message shown when a turn ends abnormally because of
 * a *known* Kiro backend failure (a wedged subprocess, an idle / wall-clock
 * watchdog firing, or the kiro-cli `-32603 "Internal error" / "Kiro failed to
 * generate a response"` JSON-RPC rejection). These are infrastructure-level
 * hiccups in the inference subprocess that the user / parent agent can do
 * nothing about and that leak no useful signal when surfaced verbatim — the
 * raw strings (`session/prompt failed: {"code":-32603,...}`,
 * `subprocess wedged (recycle required ...)`) only ever confused readers.
 *
 * Per the product line ("internal hiccups are acceptable; leaking them to the
 * UX is not"), the terminal-failure paths convert a recognised raw error into
 * this single phrase before it reaches Slack / the webapp / the parent agent.
 * The RAW message is still logged to CloudWatch (see the worker's
 * `handleTurnError` / `buildPromptFailureResult`) so internal observability is
 * preserved.
 *
 * IMPORTANT (review note S3): this phrase is only ever surfaced on the
 * TERMINAL path — the auto-retrigger budget is exhausted / the turn gave up, or
 * an uncaught error reached `handleTurnError`. While the child is still
 * self-recovering (budget remaining) the failure is hidden entirely (case A:
 * `previewText:'' + skipFinalize`). The wording therefore must NOT claim the
 * system "recovered automatically" — that would contradict the give-up
 * reality. It states the neutral fact and invites a manual retry.
 */
export const CANONICAL_KIRO_FAILURE_MESSAGE =
  'A temporary internal error prevented the agent from completing this turn. Please re-send your message if a response is still needed.';

/**
 * Returns true when a prompt error message indicates a watchdog-triggered
 * timeout that the recovery path should react to (idle watchdog, soft / hard
 * wall-clock watchdogs, the legacy wall-clock wording, or a wedged subprocess
 * that never settled the previous prompt). Lives in agent-core so both the
 * worker recovery path and the orchestrator UX-sanitiser share one definition.
 *
 * NOTE: this predicate is evaluated only on the worker's Kiro recovery path,
 * where the input is ALWAYS a kiro `prompt()` rejection, so the generic
 * `idle for` / `wall-clock` / `timed out` substrings are safe here. The
 * UX-sanitiser ({@link isKnownKiroInternalError}) is applied to arbitrary
 * uncaught errors and therefore additionally requires a kiro-specific marker.
 */
export const isPromptTimeoutOrIdleError = (msg: string): boolean =>
  msg.includes('idle for') ||
  msg.includes('wall-clock') ||
  msg.includes('timed out') ||
  msg.includes(PROMPT_SETTLE_WEDGED_ERROR);

/**
 * Substrings that unambiguously identify a message as originating from the
 * kiro-cli ACP subprocess / the worker's Kiro backend wrapper. Every Kiro
 * failure that can reach `handleTurnError` carries at least one of these:
 *   - `Kiro CLI error:`  — the worker's outer-catch wrapper for any kiro turn
 *     failure (`kiro-agent-loop.ts`).
 *   - `Kiro CLI process` — the `process died` rejection.
 *   - `Kiro ACP prompt`  — the idle / hard wall-clock watchdog rejections.
 *   - `session/prompt`   — the raw JSON-RPC `session/prompt failed: {...}`
 *     rejection (carries the `-32603` / "Internal error" / "Kiro failed to
 *     generate a response" payloads).
 *   - `kiro-cli`         — the wedged-settle error (PROMPT_SETTLE_WEDGED_ERROR).
 *
 * Requiring one of these as an AND condition prevents the UX-sanitiser from
 * collapsing a NON-kiro error that merely happens to contain a generic phrase
 * like "Internal error" or "timed out" (e.g. an AWS SDK timeout, a tool's own
 * "Internal error") — those must still surface verbatim so real bugs are not
 * hidden.
 */
const KIRO_SPECIFIC_MARKERS = ['Kiro CLI error', 'Kiro CLI process', 'Kiro ACP prompt', 'session/prompt', 'kiro-cli'];

const hasKiroMarker = (msg: string): boolean => KIRO_SPECIFIC_MARKERS.some((m) => msg.includes(m));

/**
 * Recognise the raw kiro-cli failures that carry no actionable meaning for a
 * human reader and should be collapsed to {@link CANONICAL_KIRO_FAILURE_MESSAGE}.
 *
 * Two-part gate:
 *   1. the message must carry a kiro-specific marker ({@link KIRO_SPECIFIC_MARKERS}),
 *      AND
 *   2. it must look like one of the known infra failure shapes (a recyclable
 *      timeout/idle/wedge, OR a `-32603` / "Internal error" / "Kiro failed to
 *      generate a response" / "process died" payload).
 *
 * The wedged-settle error (PROMPT_SETTLE_WEDGED_ERROR) already contains
 * `kiro-cli`, so it satisfies (1) on its own. This keeps a superset
 * relationship with {@link isPromptTimeoutOrIdleError} for genuine kiro errors
 * while never masking an unrelated error.
 */
export const isKnownKiroInternalError = (msg: string): boolean => {
  if (!hasKiroMarker(msg)) return false;
  return (
    isPromptTimeoutOrIdleError(msg) ||
    msg.includes('Kiro failed to generate a response') ||
    msg.includes('Internal error') ||
    msg.includes('process died') ||
    msg.includes('prompt cancelled') ||
    msg.includes('-32603')
  );
};

/**
 * Map a raw turn-failure message to the text that may safely reach the user /
 * parent. Recognised Kiro infrastructure errors collapse to the canonical
 * phrase; anything unrecognised passes through unchanged so genuinely
 * actionable errors (e.g. a bug in tool code) are still surfaced verbatim.
 *
 * `[System] Prompt failed after retry: <raw>` style prefixes are tolerated:
 * the predicate matches on substring, so a wrapped raw error is still
 * recognised and collapsed.
 */
export const toUserFacingTurnError = (rawMsg: string): string =>
  isKnownKiroInternalError(rawMsg) ? CANONICAL_KIRO_FAILURE_MESSAGE : rawMsg;
