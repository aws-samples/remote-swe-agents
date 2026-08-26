import { ModelType } from './model';

export type MessageItem = {
  /**
   * message-${workerId}`
   */
  PK: `message-${string}`;
  /**
   * chronologically-sortable key (usually stringified timestamp)
   */
  SK: string;
  /**
   * messsage.content in json string
   */
  content: string;
  role: string;
  tokenCount: number;
  messageType: string;
  slackUserId?: string;
  /**
   * Thinking budget in tokens when ultrathink is enabled
   */
  thinkingBudget?: number;
  modelOverride?: ModelType;
  /**
   * Per-message override of the Kiro CLI model. Mirrors `modelOverride` for
   * Bedrock sessions. When set, the Kiro backend issues a `/model <id>`
   * slash-command prompt before the user message so subsequent turns run on
   * the chosen model.
   */
  kiroModelOverride?: string;
  /**
   * Cognito user ID of the message sender (for per-user inference mode / API key lookup)
   */
  senderUserId?: string;
  /**
   * Human-readable display name of the user who sent this message. Populated
   * on `userMessage` items so the webapp UI can render "Alice" instead of
   * the generic "User" label. Optional to keep backward compatibility with
   * messages persisted before this field was introduced.
   *
   * - Slack: resolved via `users.info` display_name / real_name.
   * - Webapp: local part of the Cognito email (see `deriveDisplayName`).
   */
  senderDisplayName?: string;
  /**
   * Origin of the user message: "slack", "webapp", or "apikey". Mirrors the
   * `sender.type` embedded in the LLM prompt envelope so the UI can pick a
   * suitable icon without re-parsing the message text. `apikey` indicates
   * the message came in via the REST API (`/api/sessions/[sessionId]`)
   * authenticated with an API key, in which case `senderUserId` holds the
   * key id and `senderDisplayName` holds the key description.
   */
  senderType?: 'slack' | 'webapp' | 'apikey';
  /**
   * Session ID of the agent that sent this message (for agent-to-agent communication)
   */
  senderSessionId?: string;
  /**
   * Display name of the sender agent
   */
  senderAgentName?: string;
  /**
   * Session ID of the target agent that received this message (for agent-to-agent communication)
   */
  targetSessionId?: string;
  /**
   * Display name of the target agent
   */
  targetAgentName?: string;
  /**
   * Whether this is an acknowledge (non-waking) message
   */
  isAcknowledge?: boolean;
  /**
   * DynamoDB TTL (epoch seconds). When set, DDB auto-deletes the item after
   * expiry. Used for ephemeral records like user-delivery-dedup log entries.
   */
  TTL?: number;
};

/**
 * The set of `messageType` values that represent real user-originated input
 * eligible for re-delivery to the LLM (typed by a human, delivered by a
 * parent agent, fired by an EventBridge trigger, or emitted by the worker
 * itself when a tool error feedback turn must be inserted).
 *
 * `toolUse` and `toolResult` are intentionally excluded because they are
 * synthesised by the agent loop and must not be treated as fresh input
 * across a turn boundary.
 *
 * Shared between the worker's tail aggregation and the kiro-cli session
 * synthesiser (`packages/worker/src/agent/kiro-session-synth.ts`) so the
 * two paths can never drift apart.
 */
export const USER_INPUT_MESSAGE_TYPES = new Set<string>([
  'userMessage',
  'eventTrigger',
  'agentMessage',
  'errorFeedback',
  'systemRetrigger',
  'mermaidFeedback',
]);

/**
 * Internal-only `messageType` for a turn-level failure record (e.g. a Kiro
 * prompt that failed after the in-turn retry while the child self-recovers via
 * auto-retrigger). The full raw error is persisted under this type for
 * debugging, but it is deliberately:
 *   - excluded from `getConversationHistory` by default (does not enter the
 *     LLM context),
 *   - skipped by the kiro-cli session synthesiser (unknown type → skipped),
 *   - and NOT rendered by the webapp (no `case` for it),
 * so a transient infrastructure hiccup never leaks to the UX.
 */
export const INTERNAL_ERROR_MESSAGE_TYPE = 'internalError';

/**
 * Internal-only `messageType` marker written when the Kiro auto-recovery budget
 * is exhausted and the turn gives up. It CLOSES the active retrigger burst so a
 * subsequent failure starts a fresh time budget (see `getRetriggerBurstStats`
 * in the worker). Like {@link INTERNAL_ERROR_MESSAGE_TYPE} it is excluded from
 * the default `getConversationHistory` view, skipped by the kiro-cli session
 * synthesiser, and not rendered by the webapp, so it never reaches the UX or
 * the LLM context. It is read back only via `{ includeAll: true }`.
 */
export const RETRIGGER_GIVEUP_MESSAGE_TYPE = 'retriggerGiveup';

/**
 * Internal-only `messageType` marker for assistant text produced when kiro-cli
 * responds to a `session/cancel` request (stopReason `cancelled`). The text is
 * typically a placeholder like "Response was interrupted by the user" injected
 * by the inference backend — it carries no user-facing value and would confuse
 * the user because the cancel was triggered by the orchestrator, not by them.
 *
 * Same filtering contract as {@link INTERNAL_ERROR_MESSAGE_TYPE}: excluded from
 * the default conversation history view, skipped by the kiro-cli session
 * synthesiser, and not rendered in the webapp. Preserved in DynamoDB for
 * debugging / audit.
 */
export const CANCELLED_TURN_MESSAGE_TYPE = 'cancelledTurn';
