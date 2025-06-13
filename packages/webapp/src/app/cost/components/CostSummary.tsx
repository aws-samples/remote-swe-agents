'use client';

import { Card } from '@/components/ui/card';
import { DollarSign, MessageSquare, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface CostSummaryProps {
  totalCost: number;
  tokenCounts: TokenCounts;
}

export default function CostSummary({ totalCost, tokenCounts }: CostSummaryProps) {
  const t = useTranslations('cost');
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
      {/* Total Cost Card */}
      <Card className="p-6 border border-gray-200 dark:border-gray-700 shadow-sm flex items-center">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-full bg-green-100 dark:bg-green-900">
            <DollarSign className="h-6 w-6 text-green-600 dark:text-green-300" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('totalCost')}</p>
            <h3 className="text-2xl font-bold">${totalCost.toFixed(2)}</h3>
          </div>
        </div>
      </Card>

      {/* Total Tokens Card */}
      <Card className="p-6 border border-gray-200 dark:border-gray-700 shadow-sm flex items-center">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900">
            <MessageSquare className="h-6 w-6 text-blue-600 dark:text-blue-300" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('totalTokens')}</p>
            <h3 className="text-2xl font-bold">{tokenCounts.total.toLocaleString()}</h3>
          </div>
        </div>
      </Card>

      {/* Input/Output Tokens Card */}
      <Card className="p-6 border border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-full bg-purple-100 dark:bg-purple-900">
            <Zap className="h-6 w-6 text-purple-600 dark:text-purple-300" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">{t('inputOutputTokens')}</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <div>
                <span className="font-medium">{t('input')}:</span> {tokenCounts.input.toLocaleString()}
              </div>
              <div>
                <span className="font-medium">{t('output')}:</span> {tokenCounts.output.toLocaleString()}
              </div>
              <div>
                <span className="font-medium">{t('cacheRead')}:</span> {tokenCounts.cacheRead.toLocaleString()}
              </div>
              <div>
                <span className="font-medium">{t('cacheWrite')}:</span> {tokenCounts.cacheWrite.toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Token Usage Breakdown */}
      <Card className="p-6 border border-gray-200 dark:border-gray-700 shadow-sm md:col-span-3">
        <h3 className="text-lg font-semibold mb-4">{t('tokenUsageBreakdown')}</h3>
        <div className="relative pt-1">
          <div className="flex mb-2 items-center justify-between">
            <div>
              <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full bg-green-200 text-green-800">
                {t('input')}
              </span>
            </div>
            <div className="text-right">
              <span className="text-xs font-semibold inline-block">
                {tokenCounts.total > 0 ? ((tokenCounts.input / tokenCounts.total) * 100).toFixed(1) : '0'}%
              </span>
            </div>
          </div>
          <div className="overflow-hidden h-2 mb-4 text-xs flex rounded bg-gray-200">
            <div
              style={{ width: `${tokenCounts.total > 0 ? (tokenCounts.input / tokenCounts.total) * 100 : 0}%` }}
              className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-green-500"
            ></div>
          </div>

          <div className="flex mb-2 items-center justify-between">
            <div>
              <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full bg-blue-200 text-blue-800">
                {t('output')}
              </span>
            </div>
            <div className="text-right">
              <span className="text-xs font-semibold inline-block">
                {tokenCounts.total > 0 ? ((tokenCounts.output / tokenCounts.total) * 100).toFixed(1) : '0'}%
              </span>
            </div>
          </div>
          <div className="overflow-hidden h-2 mb-4 text-xs flex rounded bg-gray-200">
            <div
              style={{ width: `${tokenCounts.total > 0 ? (tokenCounts.output / tokenCounts.total) * 100 : 0}%` }}
              className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-blue-500"
            ></div>
          </div>

          <div className="flex mb-2 items-center justify-between">
            <div>
              <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full bg-purple-200 text-purple-800">
                {t('cacheRead')}
              </span>
            </div>
            <div className="text-right">
              <span className="text-xs font-semibold inline-block">
                {tokenCounts.total > 0 ? ((tokenCounts.cacheRead / tokenCounts.total) * 100).toFixed(1) : '0'}%
              </span>
            </div>
          </div>
          <div className="overflow-hidden h-2 mb-4 text-xs flex rounded bg-gray-200">
            <div
              style={{ width: `${tokenCounts.total > 0 ? (tokenCounts.cacheRead / tokenCounts.total) * 100 : 0}%` }}
              className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-purple-500"
            ></div>
          </div>

          <div className="flex mb-2 items-center justify-between">
            <div>
              <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full bg-yellow-200 text-yellow-800">
                {t('cacheWrite')}
              </span>
            </div>
            <div className="text-right">
              <span className="text-xs font-semibold inline-block">
                {tokenCounts.total > 0 ? ((tokenCounts.cacheWrite / tokenCounts.total) * 100).toFixed(1) : '0'}%
              </span>
            </div>
          </div>
          <div className="overflow-hidden h-2 mb-4 text-xs flex rounded bg-gray-200">
            <div
              style={{ width: `${tokenCounts.total > 0 ? (tokenCounts.cacheWrite / tokenCounts.total) * 100 : 0}%` }}
              className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-yellow-500"
            ></div>
          </div>
        </div>
      </Card>
    </div>
  );
}
