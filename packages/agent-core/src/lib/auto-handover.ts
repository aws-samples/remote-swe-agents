/**
 * Context-window self-awareness (model-driven handover).
 *
 * The worker measures each turn's context-window utilisation (a single
 * normalised `contextUsagePercentage` populated by both the Bedrock and Kiro
 * backends — see `TurnResult`) and surfaces it back to the MODEL via a dynamic
 * per-turn "environment" block. The model can then decide, on its own, to hand
 * its work over to a fresh successor session (by calling the `Create New Session`
 * tool with `role: 'successor'`) before its context fills up.
 *
 * There is intentionally NO orchestrator-side mechanical auto-fire: handover is
 * a decision the agent makes, not something the runtime forces at a fixed
 * percentage. This module therefore only builds the informational block; it
 * performs no session creation or reparenting itself.
 */

/**
 * Soft guideline percentage surfaced to the model as "you are getting full".
 * It is NOT a hard trigger — the model decides when to hand over. Presented as
 * a rule-of-thumb so the agent has time to wrap up (persist state, summarise,
 * reach a clean stopping point) and spin up a successor before it runs into
 * middle-out truncation (Bedrock) or a context-overflow error (Kiro).
 *
 * ~80% leaves roughly a fifth of the window (~40k tokens on a 200k model) as
 * head-room to compose a handover message and let the successor start cleanly.
 */
export const CONTEXT_USAGE_GUIDELINE_PERCENTAGE = 80;

/**
 * Build the dynamic "environment" block that tells the MODEL its own current
 * context-window utilisation and instructs it to hand over on its own when it
 * is getting full.
 *
 * IMPORTANT: this string is meant to live in the per-turn ENVIRONMENT layer
 * (a dynamic section regenerated every inference and NOT persisted into the
 * conversation history), never appended to the stored user prompt. Appending
 * it per-turn would accumulate in history and itself consume context — the
 * opposite of what a context-management feature should do.
 *
 * Returns `undefined` when the percentage is unknown (e.g. the very first turn
 * of a session, before any usage has been measured), so callers can omit the
 * block entirely rather than show a misleading value.
 */
export const buildContextUsageEnvironmentBlock = (
  contextUsagePercentage: number | undefined,
  options: { guideline?: number } = {}
): string | undefined => {
  if (contextUsagePercentage === undefined || !Number.isFinite(contextUsagePercentage)) return undefined;
  const guideline = options.guideline ?? CONTEXT_USAGE_GUIDELINE_PERCENTAGE;
  const pct = Math.max(0, Math.min(100, contextUsagePercentage));

  return [
    '## Context Window Usage',
    `Your conversation is currently using ~${pct.toFixed(0)}% of the available context window.`,
    `As a rule of thumb, once usage climbs past ~${guideline}% you should hand your work over to a fresh successor session ` +
      'rather than pushing on until the window overflows (which forces lossy truncation of earlier context). ' +
      'To hand over, call the `Create New Session` tool with `role: "successor"` and pass a thorough handover message that ' +
      'captures the task, everything done so far, current state, and the concrete next steps — the successor starts from ' +
      'that message, so include enough detail for it to continue seamlessly without re-reading this conversation. ' +
      'Before handing over, make sure important state is durably persisted (commit/push code, write notes to files, open the PR). ' +
      'If you were yourself just started by a handover, prioritise making concrete progress first and only hand over again ' +
      'after substantial work and genuinely high usage — do not hand over immediately.',
  ].join('\n');
};
