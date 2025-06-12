import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';

import { AgentStatus, SessionItem } from '../schema';
import { bedrockConverse } from './converse';

export const saveSessionInfo = async (workerId: string, initialMessage: string) => {
  const now = Date.now();
  const timestamp = String(now).padStart(15, '0');

  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: 'sessions',
        SK: workerId,
        workerId,
        createdAt: now,
        LSI1: timestamp,
        initialMessage,
        instanceStatus: 'terminated',
        sessionCost: 0,
        agentStatus: 'pending',
      } satisfies SessionItem,
    })
  );
};

/**
 * Get session information from DynamoDB
 * @param workerId Worker ID to fetch session information for
 * @returns Session information including instance status
 */
export async function getSession(workerId: string): Promise<SessionItem | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: 'sessions',
        SK: workerId,
      },
    })
  );

  if (!result.Item) {
    return;
  }

  return result.Item as SessionItem;
}

export const getSessions = async (): Promise<SessionItem[]> => {
  const res = await ddb.send(
    new QueryCommand({
      TableName,
      IndexName: 'LSI1',
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'sessions',
      },
      ScanIndexForward: false, // DESC order
      Limit: 50,
    })
  );

  return (res.Items ?? []) as SessionItem[];
};

/**
 * Update agent status for a session
 * @param workerId Worker ID of the session to update
 * @param agentStatus New agent status
 */
export const updateSessionAgentStatus = async (workerId: string, agentStatus: AgentStatus): Promise<void> => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: 'sessions',
        SK: workerId,
      },
      UpdateExpression: 'SET agentStatus = :agentStatus',
      ExpressionAttributeValues: {
        ':agentStatus': agentStatus,
      },
    })
  );
};

/**
 * Generate a title for a session using the first user message
 * @param workerId Worker ID of the session
 * @param userMessage First user message to generate a title from
 * @returns Generated title string (max 10 characters)
 */
export const generateSessionTitle = async (workerId: string, userMessage: string): Promise<string> => {
  try {
    const res = await bedrockConverse(workerId, ['haiku3.5'], {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: `Generate a concise title (maximum 10 characters) that represents this message: "${userMessage}"

Important: The title must be 10 characters or fewer. Do not include any explanations or additional text.`,
            },
          ],
        },
      ],
      inferenceConfig: {
        maxTokens: 50,
      },
    });

    const title = res.output?.message?.content?.at(0)?.text?.trim() || 'New Chat';

    // Ensure the title is not longer than 10 characters
    return title.length > 10 ? title.substring(0, 10) : title;
  } catch (error) {
    console.error('Error generating session title:', error);
    return 'New Chat'; // Default title in case of error
  }
};

/**
 * Save a generated title to the session in DynamoDB
 * @param workerId Worker ID of the session to update
 * @param title Generated title to save
 */
export const saveSessionTitle = async (workerId: string, title: string): Promise<void> => {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName,
        Key: {
          PK: 'sessions',
          SK: workerId,
        },
        UpdateExpression: 'SET generatedTitle = :title',
        ExpressionAttributeValues: {
          ':title': title,
        },
      })
    );
  } catch (error) {
    console.error('Error saving session title:', error);
  }
};
