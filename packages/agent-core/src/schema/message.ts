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
