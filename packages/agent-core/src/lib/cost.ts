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

      console.log(
        `Model ${modelId}: ${inputTokens} input, ${outputTokens} output, ${cacheReadTokens} cache read, ${cacheWriteTokens} cache write tokens = ${modelCost.toFixed(6)}`
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
