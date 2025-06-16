import Header from '@/components/Header';
import { getTranslations } from 'next-intl/server';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { calculateCost, getSessions } from '@remote-swe-agents/agent-core/lib';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import CostSummary from './components/CostSummary';
import CostBreakdown from './components/CostBreakdown';
import DateSelector from './components/DateSelector';
import { RefreshOnFocus } from '@/components/RefreshOnFocus';

export default async function CostAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>;
}) {
  // Get translations
  const t = await getTranslations('cost');
  const params = await searchParams;

  // Calculate date range based on query parameters or default to current month
  const now = new Date();
  const year = params.year ? parseInt(params.year) : now.getFullYear();
  const month = params.month ? parseInt(params.month) - 1 : now.getMonth(); // month is 0-indexed

  const startOfMonth = new Date(year, month, 1);
  const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59, 999);
  const startDate = startOfMonth.getTime();
  const endDate = endOfMonth.getTime();

  // Get sessions filtered by date range
  const filteredSessions = await getSessions(0, { startDate, endDate });

  // Variables to store aggregated data
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  const allTokenUsageData = [];

  // For each session, fetch token usage data
  for (const session of filteredSessions) {
    const { workerId } = session;

    // Query token usage records for this session
    // TODO: very inefficient. Maybe we should the token stats.
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
      const modelCost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

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
  const sessionCosts = filteredSessions.map((session) => ({
    workerId: session.workerId,
    initialMessage: session.initialMessage,
    sessionCost: session.sessionCost || 0,
    createdAt: session.createdAt,
  }));

  // Group data by model
  const modelCosts = allTokenUsageData.reduce(
    (acc, item) => {
      const existingModel = acc.find((model) => model.modelId === item.modelId);

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
    },
    [] as Array<{
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalCost: number;
    }>
  );

  // Prepare data for the components
  const costData = {
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

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />
      <RefreshOnFocus />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6 pt-20">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">{t('title')}</h1>
          <p className="text-gray-600 dark:text-gray-300">{t('description')}</p>
        </div>

        {/* Date Selector */}
        <DateSelector />

        {/* Cost Summary Component */}
        <CostSummary totalCost={costData.totalCost} tokenCounts={costData.tokenCounts} />

        {/* Cost Breakdown Components */}
        <CostBreakdown sessionCosts={costData.sessionCosts} modelCosts={costData.modelCosts} />
      </main>
    </div>
  );
}
