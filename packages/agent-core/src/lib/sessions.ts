import { GetCommand, QueryCommand, QueryCommandInput, UpdateCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { AgentStatus, SessionItem } from '../schema';
import { bedrockConverse } from './converse';

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

export const getSessions = async (
  limit: number = 50,
  range?: { startDate: number; endDate: number }
): Promise<SessionItem[]> => {
  const queryParams: QueryCommandInput = {
    TableName,
    IndexName: 'LSI1',
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': 'sessions',
    },
    ScanIndexForward: false, // DESC order
  };

  // Add date range filter if provided
  if (range) {
    const startTimestamp = String(range.startDate).padStart(15, '0');
    const endTimestamp = String(range.endDate).padStart(15, '0');

    queryParams.KeyConditionExpression += ' AND LSI1 BETWEEN :startDate AND :endDate';
    queryParams.ExpressionAttributeValues![':startDate'] = startTimestamp;
    queryParams.ExpressionAttributeValues![':endDate'] = endTimestamp;
  }

  // If limit is 0, fetch all results using pagination
  if (limit === 0) {
    const paginator = paginateQuery(
      {
        client: ddb,
      },
      queryParams
    );
    const items: SessionItem[] = [];
    for await (const page of paginator) {
      if (page.Items != null) {
        items.push(...(page.Items as SessionItem[]));
      }
    }
    return items.filter((session) => !session.isHidden);
  }

  // Otherwise, use the specified limit
  queryParams.Limit = limit;
  const res = await ddb.send(new QueryCommand(queryParams));

  const items = (res.Items ?? []) as SessionItem[];
  return items.filter((session) => !session.isHidden);
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
 * Update isHidden field for a session
 * @param workerId Worker ID of the session to update
 * @param isHidden Whether the session should be hidden
 */
export const updateSessionVisibility = async (workerId: string, isHidden: boolean): Promise<void> => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: 'sessions',
        SK: workerId,
      },
      UpdateExpression: 'SET isHidden = :isHidden',
      ExpressionAttributeValues: {
        ':isHidden': isHidden,
      },
    })
  );
};

/**
 * Generate a session title using Bedrock Claude Haiku model
 * @param workerId Worker ID of the session to update (to track token usage)
 * @param message The message content to generate title from
 * @returns A generated title (10 characters or less)
 */
export const generateSessionTitle = async (workerId: string, message: string): Promise<string> => {
  try {
    console.log(message);
    const prompt = `
Based on the following chat history, create a concise title for the conversation that is 15 characters or less.
The title should be brief but descriptive of the message content or intent.
Only return the title itself without any explanation or additional text.
Use the same language that was used in the conversation.

Messages: ${message}
    `.trim();

    const { response } = await bedrockConverse(workerId, ['haiku3.5'], {
      inferenceConfig: {
        maxTokens: 50,
        temperature: 0.8,
      },
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }],
        },
        {
          role: 'assistant',
          content: [{ text: 'Title:' }],
        },
      ],
    });
    const output = response?.output?.message?.content?.[0].text ?? '';
    let title = output.trim();
    return title;
  } catch (error) {
    console.error('Error generating session title:', error);
    return '';
  }
};

/**
 * Update title for a session
 * @param workerId Worker ID of the session to update
 * @param title The title to set for the session
 */
export const updateSessionTitle = async (workerId: string, title: string): Promise<void> => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: 'sessions',
        SK: workerId,
      },
      UpdateExpression: 'SET title = :title',
      ExpressionAttributeValues: {
        ':title': title,
      },
    })
  );
};
