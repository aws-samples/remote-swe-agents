import Header from '@/components/Header';
import { readCommonPrompt, getPreferences } from '@remote-swe-agents/agent-core/lib';
import PromptForm from './components/PromptForm';
import PreferenceSection from './components/PreferenceSection';
import GlobalPreferencesForm from './components/GlobalPreferencesForm';
import { getTranslations } from 'next-intl/server';

export default async function PreferencesPage() {
  // Get the current prompt and preferences directly in server component
  const promptData = await readCommonPrompt();
  const additionalSystemPrompt = promptData?.additionalSystemPrompt || '';
  const globalPreferences = await getPreferences();

  const t = await getTranslations('preferences');
  const promptT = await getTranslations('preferences.prompt');
  const globalT = await getTranslations('preferences.global');

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6 pt-20">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">{t('title')}</h1>
        </div>

        <div className="space-y-6">
          <PreferenceSection title={globalT('title')} description={globalT('description')}>
            <GlobalPreferencesForm preference={globalPreferences} />
          </PreferenceSection>

          <PreferenceSection title={promptT('title')} description={promptT('description')}>
            <PromptForm initialPrompt={additionalSystemPrompt} />
          </PreferenceSection>
        </div>
      </main>
    </div>
  );
}
