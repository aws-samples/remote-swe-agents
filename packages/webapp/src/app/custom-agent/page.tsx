import Header from '@/components/Header';
import { getTranslations } from 'next-intl/server';
import CustomAgentForm from './components/CustomAgentForm';
import PreferenceSection from '../preferences/components/PreferenceSection';

export const dynamic = 'force-dynamic';

export default async function CustomAgentPage() {
  const t = await getTranslations('customAgent');

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6 pt-20">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">{t('title')}</h1>
          <p className="text-gray-600 dark:text-gray-400">{t('description')}</p>
        </div>

        <div className="space-y-6">
          <PreferenceSection title={t('create.title')} description={t('create.description')}>
            <CustomAgentForm />
          </PreferenceSection>
        </div>
      </main>
    </div>
  );
}
