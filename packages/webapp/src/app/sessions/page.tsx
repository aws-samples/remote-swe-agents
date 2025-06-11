import Header from '@/components/Header';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Plus, MessageSquare, Clock, DollarSign } from 'lucide-react';
import { getSessions } from '@remote-swe-agents/agent-core/lib';
import { getTranslations } from 'next-intl/server';
import { RefreshOnFocus } from '@/components/RefreshOnFocus';

export default async function SessionsPage() {
  const sessions = await getSessions();
  const t = await getTranslations('sessions');

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />
      <RefreshOnFocus />

      <main className="flex-grow">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('aiAgentSessions')}</h1>
            <Link href="/sessions/new">
              <Button className="flex items-center gap-2">
                <Plus className="w-4 h-4" />
                {t('newSession')}
              </Button>
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {sessions.map((session) => (
              <Link key={session.workerId} href={`/sessions/${session.workerId}`} className="block">
                <div className="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg p-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex flex-col h-40">
                  <div className="flex items-center gap-2 mb-3">
                    <MessageSquare className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{session.SK}</h3>
                  </div>
                  
                  <p className="text-xs text-gray-600 dark:text-gray-300 mb-4 flex-1 line-clamp-3 overflow-hidden">
                    {session.initialMessage}
                  </p>
                  
                  <div className="space-y-2 text-xs text-gray-500 dark:text-gray-400">
                    <div className="flex items-center gap-1 truncate">
                      <Clock className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">{new Date(session.createdAt).toLocaleDateString()}</span>
                    </div>
                    
                    <div className="flex items-center gap-1 truncate">
                      <span
                        className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                          session.instanceStatus === 'running'
                            ? 'bg-green-500'
                            : session.instanceStatus === 'starting'
                              ? 'bg-blue-500'
                              : session.instanceStatus === 'stopped'
                                ? 'bg-gray-500'
                                : 'bg-gray-500'
                        }`}
                      />
                      <span className="truncate">
                        {session.instanceStatus === 'running'
                          ? t('sessionStatus.running')
                          : session.instanceStatus === 'starting'
                            ? t('sessionStatus.starting')
                            : session.instanceStatus === 'stopped'
                              ? t('sessionStatus.stopped')
                              : t('sessionStatus.terminated')}
                      </span>
                    </div>
                    
                    <div className="flex items-center">
                      <DollarSign className="w-3 h-3 flex-shrink-0" />
                      <span>{(session.sessionCost ?? 0).toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {sessions.length === 0 && (
            <div className="text-center py-12">
              <MessageSquare className="w-12 h-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">{t('noSessionsFound')}</h3>
              <p className="text-gray-600 dark:text-gray-300 mb-6">{t('createSessionToStart')}</p>
              <Link href="/sessions/new">
                <Button>
                  <Plus className="w-4 h-4 mr-2" />
                  {t('newSession')}
                </Button>
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
