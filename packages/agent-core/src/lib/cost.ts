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
 * Calculate total cost from DynamoDB records for a session
 */
async function calculateTotalSessionCost(workerId: string) {
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

    const items = result.Items || [];
    let totalCost = 0;

    // Group tokens by modelId to calculate cost separately for each model
    const tokensByModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {};

    // Process each item
    for (const item of items) {
      if (!item.tokenCount) continue;

      // Extract modelId from the item, default to 'sonnet3.7' if not present
      const modelId = item.modelId || 'sonnet3.7';

      // Initialize model entry if doesn't exist
      if (!tokensByModel[modelId]) {
        tokensByModel[modelId] = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }

      // Accumulate tokens by type
      if (item.messageType === 'toolUse') {
        tokensByModel[modelId].output += item.tokenCount;
      } else if (item.messageType === 'userMessage' || item.messageType === 'toolResult') {
        tokensByModel[modelId].input += item.tokenCount;
      }

      // Add cache tokens if available
      if (item.cacheReadTokens) {
        tokensByModel[modelId].cacheRead += item.cacheReadTokens;
      }
      if (item.cacheWriteTokens) {
        tokensByModel[modelId].cacheWrite += item.cacheWriteTokens;
      }
    }

    // Calculate cost for each model
    for (const [modelId, tokens] of Object.entries(tokensByModel)) {
      const modelCost = calculateCost(modelId, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite);
      totalCost += modelCost;

      console.log(
        `Model ${modelId}: ${tokens.input} input, ${tokens.output} output, ${tokens.cacheRead} cache read, ${tokens.cacheWrite} cache write tokens = ${modelCost.toFixed(6)}`
      );
    }

    return totalCost;
  } catch (error) {
    console.error(`Error calculating session cost for workerId ${workerId}:`, error);
    return 0;
  }
}

/**
 * Updates the session cost in DynamoDB by calculating cost for each model
 */
export async function updateSessionCost(workerId: string) {
  try {
    // Calculate total cost across all models
    const totalCost = await calculateTotalSessionCost(workerId);

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
          ':cost': totalCost,
        },
      })
    );

    console.log(`Session cost updated to ${totalCost.toFixed(6)} USD for workerId ${workerId}`);
  } catch (error) {
    console.error(`Error updating session cost for workerId ${workerId}:`, error);
  }
}
