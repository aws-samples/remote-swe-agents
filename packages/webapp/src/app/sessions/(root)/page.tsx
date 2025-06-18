import Header from '@/components/Header';
import { getSessions } from '@remote-swe-agents/agent-core/lib';
import { RefreshOnFocus } from '@/components/RefreshOnFocus';
import SessionsList from './components/SessionsList';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SessionsPage() {
  const sessions = await getSessions();

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />
      <RefreshOnFocus />

      <main className="flex-grow pt-20">
        <div className="max-w-6xl mx-auto px-4 pb-8">
          <SessionsList initialSessions={sessions} />
        </div>
      </main>
    </div>
  );
}
