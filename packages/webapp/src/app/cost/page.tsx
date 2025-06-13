import Header from '@/components/Header';
import { getTranslations } from 'next-intl/server';
import { fetchCostDataAction } from './actions';
import CostSummary from './components/CostSummary';
import CostBreakdown from './components/CostBreakdown';
import { RefreshOnFocus } from '@/components/RefreshOnFocus';

export default async function CostAnalysisPage() {
  // Get translations
  const t = await getTranslations('cost');

  // Calculate date range for current month
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startDate = startOfMonth.getTime();

  // Fetch cost data for the current month
  const costDataResult = await fetchCostDataAction({ startDate });

  // Set default values in case data is undefined
  const defaultCostData = {
    totalCost: 0,
    tokenCounts: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    sessionCosts: [],
    modelCosts: [],
    rawData: [],
  };

  // Extract data from the result or use defaults
  const costData = costDataResult?.data?.success ? costDataResult.data : defaultCostData;

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />
      <RefreshOnFocus />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">{t('title')}</h1>
          <p className="text-gray-600 dark:text-gray-300">{t('description')}</p>
        </div>

        {/* Cost Summary Component */}
        <CostSummary totalCost={costData.totalCost} tokenCounts={costData.tokenCounts} t={t} />

        {/* Cost Breakdown Components */}
        <CostBreakdown sessionCosts={costData.sessionCosts} modelCosts={costData.modelCosts} t={t} />
      </main>
    </div>
  );
}
