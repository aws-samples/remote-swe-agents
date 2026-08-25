import { saveConversationHistory } from '@remote-swe-agents/agent-core/lib';
import type { Message } from '@aws-sdk/client-bedrock-runtime';

/**
 * Persist an error notification as a rendered assistant bubble (messageType 'assistant')
 * so it survives page refresh and renders as a chat bubble in the webapp.
 *
 * Best-effort: failures are logged and return `undefined` (caller continues without SK).
 * This helper exists to consolidate the persist-error-as-bubble pattern across all
 * unrecoverable error paths (handleTurnError, kiro permanent, kiro give-up, bedrock permanent,
 * bedrock circuit-breaker) and to pin the 'assistant' messageType choice in tests so a
 * regression to INTERNAL_ERROR_MESSAGE_TYPE (B3 incident) cannot recur undetected.
 */
export const persistErrorBubble = async (workerId: string, errorText: string): Promise<string | undefined> => {
  try {
    const errorMessage: Message = {
      role: 'assistant',
      content: [{ text: errorText }],
    };
    const saved = await saveConversationHistory(workerId, errorMessage, 0, 'assistant');
    return saved.SK;
  } catch (e) {
    console.error('[persistErrorBubble] Failed to persist error bubble:', e);
    return undefined;
  }
};
