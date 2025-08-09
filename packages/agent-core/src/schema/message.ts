export type MessageItem = {
  PK: string;
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
  /**
   * Override the model to use for this message
   */
  modelOverride?: string;
};
