import { GetCommand, QueryCommand, QueryCommandInput, UpdateCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { AgentStatus, SessionItem } from '../schema';
import { getConversationHistory } from './messages';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

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
 * @param message The message content to generate title from
 * @returns A generated title (10 characters or less)
 */
export const generateSessionTitle = async (message: string): Promise<string> => {
  try {
    const client = new BedrockRuntimeClient({ region: 'us-west-2' });

    const prompt = `
    Based on the following message, create a concise title that is 10 characters or less.
    The title should be brief but descriptive of the message content or intent.
    Only return the title itself without any explanation or additional text.
    
    Message: "${message}"
    
    Title:
    `;

    const command = new InvokeModelCommand({
      modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      contentType: 'application/json',
      body: JSON.stringify({
        prompt,
        max_tokens_to_sample: 20,
        temperature: 0.7,
      }),
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    let title = responseBody.completion.trim();

    // Remove any quotes if the model included them
    title = title.replace(/^["']|["']$/g, '');

    // Ensure title is 10 characters or less
    if (title.length > 10) {
      title = title.substring(0, 10);
    }

    return title;
  } catch (error) {
    console.error('Error generating session title:', error);
    // Return a default title if generation fails
    return 'New Chat';
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
