import Header from '@/components/Header';
import { readCommonPrompt } from '@remote-swe-agents/agent-core/lib';
import PromptForm from './components/PromptForm';
import { getTranslations } from 'next-intl/server';

export default async function PromptSettingsPage() {
  // Get the current prompt directly in server component
  const promptData = await readCommonPrompt();
  const additionalSystemPrompt = promptData?.additionalSystemPrompt || '';
  const t = await getTranslations('prompt_settings');

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">{t('title')}</h1>
          <p className="text-gray-600 dark:text-gray-300">{t('description')}</p>
        </div>

        <div className="border border-gray-200 dark:border-gray-800 shadow-sm rounded-lg bg-white dark:bg-gray-800">
          <div className="p-6 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-1">{t('configTitle')}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('configDescription')}</p>
          </div>

          <div className="p-6">
            <PromptForm initialPrompt={additionalSystemPrompt} />
          </div>
        </div>
      </main>
    </div>
  );
}
