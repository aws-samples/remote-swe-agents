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
};
