import HeaderWithPreferences from '@/components/HeaderWithPreferences';
import { getAllSessionsIncludingChildren, getUnreadMap } from '@remote-swe-agents/agent-core/lib';
import { RefreshOnFocus } from '@/components/RefreshOnFocus';
import SessionsList from './components/SessionsList';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SessionsPage() {
  const allSessions = await getAllSessionsIncludingChildren();
  const visibleSessions = allSessions.filter((s) => !s.isHidden);
  const { userId } = await getSession();
  const unreadMap = await getUnreadMap(userId);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <HeaderWithPreferences />
      <RefreshOnFocus />

      <main className="flex-grow pt-20">
        <div className="max-w-6xl mx-auto px-4 pb-8">
          <SessionsList initialSessions={visibleSessions} currentUserId={userId} unreadMap={unreadMap} />
        </div>
      </main>
    </div>
  );
}
