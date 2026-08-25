import { getConversationHistory, getSession, getCustomAgent } from '@remote-swe-agents/agent-core/lib';
import { resolveInferenceMode } from '@remote-swe-agents/agent-core/lib';
import { resolveModelConfig } from '@remote-swe-agents/agent-core/lib';
export { resolveInferenceMode };
import { reportProgressTool, sendToAgentTool, acknowledgeAgentTool } from '@remote-swe-agents/agent-core/tools';
import { CancellationToken } from '../common/cancellation-token';
import { updateAgentStatusWithEvent } from '../common/status';
import { InferenceMode } from '@remote-swe-agents/agent-core/schema';
import { bedrockBackend } from './backends';
import { runTurnWithBackend } from './orchestrator';

const sanitizeToolName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Tool names that should reset the lastReportedTime timer.
 * This includes tools that communicate with users OR other agents,
 * preventing the forceReport mechanism from firing unnecessarily
 * (especially in child sessions that primarily use agent-to-agent communication).
 */
export const toolNamesThatResetReportTimer = new Set([
  sanitizeToolName(reportProgressTool.name),
  sanitizeToolName(sendToAgentTool.name),
  sanitizeToolName(acknowledgeAgentTool.name),
]);

/**
 * Bedrock Converse's `image.format` field is a closed union
 * (`'png' | 'jpeg' | 'gif' | 'webp'`). MCP tool results report their
 * image via a free-form `mimeType` string, so naively splitting on "/"
 * (e.g. `image/svg+xml` → `svg+xml`, `image/jpg` → `jpg`) produces
 * values Bedrock rejects at validation time, failing the whole turn.
 *
 * Normalise the MCP-provided mime type to one of the four formats
 * Bedrock accepts. Unknown / unsupported values fall back to `'jpeg'`
 * with a `console.warn` so operators can notice the degradation without
 * the turn itself breaking.
 *
 * Exported for unit testing.
 */
export const normalizeMcpImageFormat = (mimeType: string | undefined): 'png' | 'jpeg' | 'gif' | 'webp' => {
  const raw = (mimeType ?? '').toLowerCase().trim();
  const subtype = raw.includes('/') ? raw.split('/')[1]!.trim() : raw;
  switch (subtype) {
    case 'png':
      return 'png';
    case 'jpeg':
    case 'jpg':
      return 'jpeg';
    case 'gif':
      return 'gif';
    case 'webp':
      return 'webp';
    default:
      console.warn(`[agent] MCP tool returned unsupported image mimeType="${mimeType}"; falling back to "jpeg"`);
      return 'jpeg';
  }
};

/**
 * Check whether the given tool name should reset the lastReportedTime.
 */
export const shouldResetReportTimer = (toolName: string | undefined): boolean => {
  return toolName != null && toolNamesThatResetReportTimer.has(sanitizeToolName(toolName));
};

export interface InferenceModeContext {
  sessionInferenceMode?: InferenceMode;
  customAgentInferenceMode?: InferenceMode;
  envInferenceMode?: string;
  senderUserId?: string;
}

/**
 * `resolveInferenceMode` is re-exported at the top of this file from
 * `@remote-swe-agents/agent-core/lib`. The worker re-exports it so existing
 * callers (tests, `detectInferenceMode` below) keep a single import path,
 * while the webapp imports the same implementation directly from agent-core.
 *
 * Priority: session > custom agent > env var > default (bedrock). User
 * preferences are intentionally excluded; they are only consulted at
 * session creation time (see `createSession`) and baked into the session.
 * Flipping preferences after the fact must not retroactively change the
 * backend of an existing / legacy session.
 */

/**
 * Detect the inference mode for a worker session.
 * Fetches session and custom agent config and resolves the mode.
 *
 * Priority: session (baked-in) > custom agent > env > default.
 * Sessions created before inferenceMode was persisted fall through to
 * `bedrock`, which matches the pre-Kiro single-backend world those
 * sessions were originally run under.
 *
 * NOTE: `senderUserId` is still extracted from the last user message
 * because downstream callers (e.g. kiroAgentLoop) need it to look up
 * the sender's Kiro API key. The user's `preferences.inferenceMode`
 * is NOT consulted for mode resolution.
 */
const detectInferenceMode = async (workerId: string): Promise<{ mode: InferenceMode; senderUserId?: string }> => {
  const { items } = await getConversationHistory(workerId);
  const lastUserMsg = items.filter((i) => i.role === 'user').at(-1);
  const senderUserId = lastUserMsg?.senderUserId;

  const session = await getSession(workerId);
  const customAgent = await getCustomAgent(session?.customAgentId);

  const { inferenceMode: mode } = resolveModelConfig({
    session: session ? { inferenceMode: session.inferenceMode } : undefined,
    customAgent: customAgent ? { inferenceMode: customAgent.inferenceMode } : undefined,
    env: { inferenceMode: process.env.INFERENCE_MODE },
  });

  return { mode, senderUserId };
};

export const onMessageReceived = async (workerId: string, cancellationToken: CancellationToken) => {
  // Update agent status to 'working' when starting a turn
  await updateAgentStatusWithEvent(workerId, 'working');

  try {
    // Resolve inferenceMode and dispatch to the matching backend. Only the
    // Bedrock backend is wired today; any other resolved mode falls back to it
    // until additional backends are registered.
    const { mode: inferenceMode, senderUserId } = await detectInferenceMode(workerId);
    const backend = bedrockBackend;
    await runTurnWithBackend(workerId, cancellationToken, backend, senderUserId);
  } finally {
    if (cancellationToken.isCancelled) {
      // execute any callback when set in the cancellation token.
      try {
        await cancellationToken.completeCancel();
      } catch (e) {
        console.error('[agent] completeCancel threw; resetting agentStatus as fallback:', e);
        await updateAgentStatusWithEvent(workerId, 'pending').catch((statusErr) => {
          console.error('[agent] fallback agentStatus reset also failed:', statusErr);
        });
      }
    } else {
      // Update agent status to 'pending' when finishing a turn.
      // When the turn is cancelled, do not update the status to avoid race condition.
      await updateAgentStatusWithEvent(workerId, 'pending');
    }
  }
};

export const resume = async (workerId: string, cancellationToken: CancellationToken) => {
  const { items } = await getConversationHistory(workerId);
  const lastItem = items.at(-1);
  if (
    lastItem?.messageType == 'userMessage' ||
    lastItem?.messageType == 'eventTrigger' ||
    lastItem?.messageType == 'agentMessage' ||
    lastItem?.messageType == 'toolResult' ||
    lastItem?.messageType == 'toolUse' ||
    lastItem?.messageType == 'errorFeedback' ||
    lastItem?.messageType == 'systemRetrigger' ||
    lastItem?.messageType == 'mermaidFeedback'
  ) {
    return await onMessageReceived(workerId, cancellationToken);
  }
};

/**
 * Message shown to the user when the model returns an empty final message.
 *
 * A `content_filtered` stopReason means the provider content filter blocked
 * the turn and returned an empty 200 (zero usage). We surface that explicitly
 * so it is not experienced as a silent empty reply. For any other empty
 * message (e.g. a benign empty `end_turn`) we only forward the mention, which
 * preserves the previous acknowledge-and-continue behaviour.
 */
export const emptyFinalMessageNotification = (stopReason: string | undefined, mention: string): string => {
  if (stopReason === 'content_filtered') {
    return (
      `${mention}The response was blocked by the model's content filter (stopReason: content_filtered), ` +
      `so no message could be generated. This is usually a false positive and is not caused by anything ` +
      `wrong on your side. Please try again or rephrase; if it keeps happening, start a new session.`
    );
  }
  return mention;
};
