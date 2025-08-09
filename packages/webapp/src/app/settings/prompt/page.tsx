import Header from '@/components/Header';
import { readCommonPrompt } from '@remote-swe-agents/agent-core/lib';
import PromptForm from './components/PromptForm';
import PreferenceSection from './components/PreferenceSection';
import { getTranslations } from 'next-intl/server';
import ModelForm from './components/ModelForm';

export default async function PreferencesPage() {
  // Get the current prompt directly in server component
  const promptData = await readCommonPrompt();
  const additionalSystemPrompt = promptData?.additionalSystemPrompt || '';
  const t = await getTranslations('preferences');
  const promptT = await getTranslations('preferences.prompt');

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6 pt-20">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">{t('title')}</h1>
          <p className="text-gray-600 dark:text-gray-300">{t('description')}</p>
        </div>

        <div className="space-y-6">
          <PreferenceSection title={promptT('title')} description={promptT('description')}>
            <PromptForm initialPrompt={additionalSystemPrompt} />
          </PreferenceSection>

          <PreferenceSection
            title="Foundation Model"
            description="Select the default foundation model to use for all agents. Individual agents can override this setting."
          >
            <ModelForm />
          </PreferenceSection>
        </div>
      </main>
    </div>
  );
}
