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
};
