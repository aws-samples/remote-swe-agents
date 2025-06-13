'use server';

import { authActionClient } from '@/lib/safe-action';
import { fetchCostDataSchema } from './schemas';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { calculateCost, getSessions } from '@remote-swe-agents/agent-core/lib';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

// Function to fetch all token usage data from DynamoDB
export const fetchCostDataAction = authActionClient
  .schema(fetchCostDataSchema)
  .action(async ({ parsedInput: { startDate, endDate } }) => {
    try {
      // Get all sessions
      const sessions = await getSessions();
      
      // Filter sessions by date if specified
      let filteredSessions = sessions;
      if (startDate && endDate) {
        filteredSessions = sessions.filter(
          session => session.createdAt >= startDate && session.createdAt <= endDate
        );
      } else if (startDate) {
        filteredSessions = sessions.filter(session => session.createdAt >= startDate);
      } else if (endDate) {
        filteredSessions = sessions.filter(session => session.createdAt <= endDate);
      }

      // Array to hold token usage data for all sessions
      const allTokenUsageData = [];
      let totalCost = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheReadTokens = 0;
      let totalCacheWriteTokens = 0;

      // For each session, fetch token usage data
      for (const session of filteredSessions) {
        const { workerId } = session;
        
        // Query token usage records for this session
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
        
        // Process each token usage record
        for (const item of items) {
          const modelId = item.SK; // model ID is stored in SK
          const inputTokens = item.inputToken || 0;
          const outputTokens = item.outputToken || 0;
          const cacheReadTokens = item.cacheReadInputTokens || 0;
          const cacheWriteTokens = item.cacheWriteInputTokens || 0;

          // Calculate cost for this model usage
          const modelCost = calculateCost(
            modelId, 
            inputTokens, 
            outputTokens, 
            cacheReadTokens, 
            cacheWriteTokens
          );

          // Add to totals
          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
          totalCacheReadTokens += cacheReadTokens;
          totalCacheWriteTokens += cacheWriteTokens;
          totalCost += modelCost;

          // Add model data to the result set
          allTokenUsageData.push({
            workerId,
            sessionDetails: session,
            modelId,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            cost: modelCost,
            timestamp: session.createdAt,
          });
        }
      }

      // Group data by different dimensions
      const sessionCosts = filteredSessions.map(session => ({
        workerId: session.workerId,
        initialMessage: session.initialMessage,
        sessionCost: session.sessionCost || 0,
        createdAt: session.createdAt,
      }));

      // Group data by model
      const modelCosts = allTokenUsageData.reduce((acc, item) => {
        const existingModel = acc.find(model => model.modelId === item.modelId);
        
        if (existingModel) {
          existingModel.inputTokens += item.inputTokens;
          existingModel.outputTokens += item.outputTokens;
          existingModel.cacheReadTokens += item.cacheReadTokens;
          existingModel.cacheWriteTokens += item.cacheWriteTokens;
          existingModel.totalCost += item.cost;
        } else {
          acc.push({
            modelId: item.modelId,
            inputTokens: item.inputTokens,
            outputTokens: item.outputTokens,
            cacheReadTokens: item.cacheReadTokens,
            cacheWriteTokens: item.cacheWriteTokens,
            totalCost: item.cost,
          });
        }
        
        return acc;
      }, [] as Array<{
        modelId: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        totalCost: number;
      }>);

      return {
        success: true,
        totalCost,
        tokenCounts: {
          input: totalInputTokens,
          output: totalOutputTokens,
          cacheRead: totalCacheReadTokens,
          cacheWrite: totalCacheWriteTokens,
          total: totalInputTokens + totalOutputTokens + totalCacheReadTokens + totalCacheWriteTokens,
        },
        sessionCosts,
        modelCosts,
        rawData: allTokenUsageData,
      };
    } catch (error) {
      console.error('Error fetching cost data:', error);
      throw new Error('Failed to fetch cost data');
    }
  });