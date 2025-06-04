import { getSession } from '@/lib/auth';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { getTranslations } from 'next-intl/server';

export default async function NewSessionPage() {
  const t = await getTranslations('sessions');

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />
      <main className="flex-grow p-6">
        <div className="max-w-2xl mx-auto">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('newSessionTitle')}</h1>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
            <div className="flex justify-center">
              <Button className="px-8">{t('start')}</Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
