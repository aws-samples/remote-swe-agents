import Header from '@/components/Header';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { MessageSquare, Bot, Zap } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

export default async function Home() {
  const t = await getTranslations('home');
  const sessionsT = await getTranslations('sessions');

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <div className="text-center py-16">
            <Bot className="w-16 h-16 text-blue-600 dark:text-blue-400 mx-auto mb-6" />
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">{t('title')}</h1>
            <p className="text-xl text-gray-600 dark:text-gray-300 mb-8 max-w-2xl mx-auto">{t('description')}</p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-12">
              <Link href="/sessions">
                <Button size="lg" className="flex items-center gap-2">
                  <MessageSquare className="w-5 h-5" />
                  {sessionsT('title')}
                </Button>
              </Link>
              <Link href="/sessions/new">
                <Button variant="outline" size="lg" className="flex items-center gap-2">
                  <Zap className="w-5 h-5" />
                  <span className="hidden sm:inline">{sessionsT('newSession')}</span>
                </Button>
              </Link>
            </div>

            <div className="grid md:grid-cols-3 gap-8 text-left">
              <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">🔧 Code Development</h3>
                <p className="text-gray-600 dark:text-gray-300">
                  AI supports various development tasks including file creation/editing, bug fixes, and feature
                  additions
                </p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">⚡ Real-time</h3>
                <p className="text-gray-600 dark:text-gray-300">
                  Monitor progress in real-time. Tool execution and command results are displayed instantly
                </p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">🚀 Advanced Features</h3>
                <p className="text-gray-600 dark:text-gray-300">
                  Supports professional development workflows including GitHub integration, PR creation, and test
                  execution
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
