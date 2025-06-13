'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { MessageSquare, Bot, BarChart } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

interface SessionCost {
  workerId: string;
  initialMessage?: string;
  sessionCost: number;
  createdAt: number;
}

interface ModelCost {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}

interface CostBreakdownProps {
  sessionCosts: SessionCost[];
  modelCosts: ModelCost[];
}

export default function CostBreakdown({ sessionCosts, modelCosts }: CostBreakdownProps) {
  const t = useTranslations('cost');
  // State for active tab
  const [activeTab, setActiveTab] = useState<'sessions' | 'models'>('sessions');

  return (
    <Card className="p-6 border border-gray-200 dark:border-gray-700 shadow-sm">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">{t('costBreakdown')}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{t('costBreakdownDescription')}</p>
      </div>

      {/* Tab navigation */}
      <div className="flex space-x-2 mb-6">
        <Button
          variant={activeTab === 'sessions' ? 'default' : 'outline'}
          onClick={() => setActiveTab('sessions')}
          className="flex items-center gap-2"
        >
          <MessageSquare className="h-4 w-4" />
          {t('bySession')}
        </Button>
        <Button
          variant={activeTab === 'models' ? 'default' : 'outline'}
          onClick={() => setActiveTab('models')}
          className="flex items-center gap-2"
        >
          <Bot className="h-4 w-4" />
          {t('byModel')}
        </Button>
      </div>

      {/* Session costs table */}
      {activeTab === 'sessions' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="px-4 py-3 text-left">{t('sessionId')}</th>
                <th className="px-4 py-3 text-left">{t('initialPrompt')}</th>
                <th className="px-4 py-3 text-left">{t('date')}</th>
                <th className="px-4 py-3 text-right">{t('cost')}</th>
              </tr>
            </thead>
            <tbody>
              {sessionCosts.length > 0 ? (
                sessionCosts
                  .sort((a, b) => b.sessionCost - a.sessionCost) // Sort by cost descending
                  .map((session) => (
                    <tr
                      key={session.workerId}
                      className="border-b border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/sessions/${session.workerId}`}
                          className="text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {session.workerId}
                        </Link>
                      </td>
                      <td className="px-4 py-3 max-w-[300px] truncate">{session.initialMessage || t('noMessage')}</td>
                      <td className="px-4 py-3">{new Date(session.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3 text-right font-medium">${session.sessionCost.toFixed(2)}</td>
                    </tr>
                  ))
              ) : (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                    <BarChart className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>{t('noSessionData')}</p>
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 dark:bg-gray-800">
                <td colSpan={3} className="px-4 py-3 font-medium">
                  {t('total')}
                </td>
                <td className="px-4 py-3 text-right font-bold">
                  ${sessionCosts.reduce((sum, session) => sum + session.sessionCost, 0).toFixed(2)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Model costs table */}
      {activeTab === 'models' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="px-4 py-3 text-left">{t('model')}</th>
                <th className="px-4 py-3 text-right">{t('inputTokens')}</th>
                <th className="px-4 py-3 text-right">{t('outputTokens')}</th>
                <th className="px-4 py-3 text-right">{t('cacheTokens')}</th>
                <th className="px-4 py-3 text-right">{t('cost')}</th>
              </tr>
            </thead>
            <tbody>
              {modelCosts.length > 0 ? (
                modelCosts
                  .sort((a, b) => b.totalCost - a.totalCost) // Sort by cost descending
                  .map((model) => (
                    <tr
                      key={model.modelId}
                      className="border-b border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900"
                    >
                      <td className="px-4 py-3 font-medium">{model.modelId}</td>
                      <td className="px-4 py-3 text-right">{model.inputTokens.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">{model.outputTokens.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">
                        {(model.cacheReadTokens + model.cacheWriteTokens).toLocaleString()}
                        <span className="text-xs text-gray-500 ml-1">
                          (R: {model.cacheReadTokens.toLocaleString()}, W: {model.cacheWriteTokens.toLocaleString()})
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium">${model.totalCost.toFixed(2)}</td>
                    </tr>
                  ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    <Bot className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>{t('noModelData')}</p>
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 dark:bg-gray-800">
                <td className="px-4 py-3 font-medium">{t('total')}</td>
                <td className="px-4 py-3 text-right font-medium">
                  {modelCosts.reduce((sum, model) => sum + model.inputTokens, 0).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right font-medium">
                  {modelCosts.reduce((sum, model) => sum + model.outputTokens, 0).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right font-medium">
                  {modelCosts
                    .reduce((sum, model) => sum + model.cacheReadTokens + model.cacheWriteTokens, 0)
                    .toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right font-bold">
                  ${modelCosts.reduce((sum, model) => sum + model.totalCost, 0).toFixed(2)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}
