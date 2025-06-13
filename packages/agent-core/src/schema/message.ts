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
};
