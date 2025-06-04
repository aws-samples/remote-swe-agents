import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws/ddb';

const modelPricing = {
  '3-7-sonnet': { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  '3-5-sonnet': { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  '3-5-haiku': { input: 0.0008, output: 0.004, cacheRead: 0.00008, cacheWrite: 0.001 },
  'sonnet-4': { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
  'opus-4': { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
};

// Calculate cost in USD based on token usage
export const calculateCost = (
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
) => {
  const pricing = Object.entries(modelPricing).find(([key]) => modelId.includes(key))?.[1];
  if (pricing == null) return 0;
  return (
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheReadTokens * pricing.cacheRead +
      cacheWriteTokens * pricing.cacheWrite) /
    1000
  );
};

/**
 * Get token usage from DynamoDB for all messages in the session
 */
async function getTokenUsage(workerId: string) {
  try {
    // Use simple query instead of paginator since we don't expect a large number of records
    const result = await ddb.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `message-${workerId}`,
        },
      })
    );

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let modelId = 'sonnet3.7'; // Default model ID

    const items = result.Items || [];

    for (const item of items) {
      // Sum up token counts based on message type
      if (item.tokenCount) {
        if (item.messageType === 'toolUse') {
          totalOutputTokens += item.tokenCount;
        } else if (item.messageType === 'userMessage' || item.messageType === 'toolResult') {
          totalInputTokens += item.tokenCount;
        }
      }
    }

    return {
      modelId,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
    };
  } catch (error) {
    console.error(`Error getting token usage for workerId ${workerId}:`, error);
    return {
      modelId: 'sonnet3.7',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
    };
  }
}

/**
 * Updates the session cost in DynamoDB by retrieving the latest token usage
 */
export async function updateSessionCost(workerId: string) {
  try {
    // Get total token usage from DynamoDB
    const { modelId, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens } =
      await getTokenUsage(workerId);

    // Calculate cost in USD
    const cost = calculateCost(
      modelId,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens
    );

    // Update the cost in DynamoDB
    await ddb.send(
      new UpdateCommand({
        TableName,
        Key: {
          PK: 'sessions',
          SK: workerId,
        },
        UpdateExpression: 'SET sessionCost = :cost',
        ExpressionAttributeValues: {
          ':cost': cost,
        },
      })
    );

    console.log(
      `Session cost updated to ${cost} USD for workerId ${workerId} (${totalInputTokens} input, ${totalOutputTokens} output tokens)`
    );
  } catch (error) {
    console.error(`Error updating session cost for workerId ${workerId}:`, error);
  }
}
