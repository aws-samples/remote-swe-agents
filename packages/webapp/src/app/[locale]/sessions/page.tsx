import { getSession } from '@/lib/auth';
import Header from '@/components/Header';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { getTranslations } from 'next-intl/server';

export default async function SessionsPage() {
  const t = await getTranslations('sessions');
  
  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow p-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
            <Link href="/sessions/new">
              <Button size="sm">{t('newSession')}</Button>
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border border-gray-200 dark:border-gray-700">
            <div className="text-center py-8">
              <p className="text-gray-500 dark:text-gray-400 mb-4">{t('noSessions')}</p>
              <Link href="/sessions/new">
                <Button>{t('createSession')}</Button>
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}