import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws/ddb';
import { modelConfigs } from '../schema/model';
import { updateSession } from './sessions';

// Calculate cost in USD based on token usage
export const calculateCost = (
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
) => {
  const config = Object.values(modelConfigs).find((config) => modelId.includes(config.modelId));
  if (!config) return 0;

  const pricing = config.pricing;
  return (
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheReadTokens * pricing.cacheRead +
      cacheWriteTokens * pricing.cacheWrite) /
    1000
  );
};

/**
 * Calculate total cost from token usage records in DynamoDB
 */
async function calculateTotalSessionCost(workerId: string) {
  try {
    // Query token usage records from DynamoDB
    const result = await ddb.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `token-${workerId}`,
        },
      })
    );

    const items = result.Items || [];
    let totalCost = 0;

    // Calculate cost for each model from token usage records
    for (const item of items) {
      const modelId = item.SK; // model ID is stored in SK
      const inputTokens = item.inputToken || 0;
      const outputTokens = item.outputToken || 0;
      const cacheReadTokens = item.cacheReadInputTokens || 0;
      const cacheWriteTokens = item.cacheWriteInputTokens || 0;

      const modelCost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

      totalCost += modelCost;
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

    // Update the cost using the generic updateSession function
    await updateSession(workerId, { sessionCost: totalCost });
  } catch (error) {
    console.error(`Error updating session cost for workerId ${workerId}:`, error);
  }
}
