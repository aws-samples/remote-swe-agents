import { getSession } from '@/lib/auth';
import Header from '@/components/Header';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Plus, MessageSquare, Clock, DollarSign } from 'lucide-react';
import { getSessions } from '@/app/(root)/actions';

export default async function SessionsPage() {
  const result = await getSessions({});
  const sessions = result?.data?.sessions || [];

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">AI Agent Sessions</h1>
            <Link href="/sessions/new">
              <Button className="flex items-center gap-2">
                <Plus className="w-4 h-4" />
                New Session
              </Button>
            </Link>
          </div>

          <div className="space-y-4">
            {sessions.map((session) => (
              <Link key={session.workerId} href={`/sessions/${session.workerId}`} className="block">
                <div className="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg p-6 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <MessageSquare className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{session.title}</h3>
                      </div>
                      <p className="text-gray-600 dark:text-gray-300 mb-3">{session.lastMessage}</p>
                      <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4" />
                          {new Date(session.updatedAt).toLocaleString('en-US')}
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block w-2 h-2 rounded-full ${
                              session.instanceStatus === 'running'
                                ? 'bg-green-500'
                                : session.instanceStatus === 'starting'
                                  ? 'bg-yellow-500'
                                  : session.instanceStatus === 'stopped'
                                    ? 'bg-blue-500'
                                    : 'bg-gray-500'
                            }`}
                          />
                          <span>
                            {session.instanceStatus === 'running'
                              ? 'Running'
                              : session.instanceStatus === 'starting'
                                ? 'Starting'
                                : session.instanceStatus === 'stopped'
                                  ? 'Stopped'
                                  : 'Terminated'}
                          </span>
                        </div>
                        <div className="flex items-center">
                          <DollarSign className="w-4 h-4" />
                          <span>{(session.sessionCost ?? 0).toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {sessions.length === 0 && (
            <div className="text-center py-12">
              <MessageSquare className="w-12 h-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">No sessions found</h3>
              <p className="text-gray-600 dark:text-gray-300 mb-6">
                Create a new session to start chatting with AI agents
              </p>
              <Link href="/sessions/new">
                <Button>
                  <Plus className="w-4 h-4 mr-2" />
                  New Session
                </Button>
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
