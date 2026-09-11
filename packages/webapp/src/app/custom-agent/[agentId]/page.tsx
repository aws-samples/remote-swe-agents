import HeaderWithPreferences from '@/components/HeaderWithPreferences';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeftIcon } from 'lucide-react';
import { optionalTools } from '@remote-swe-agents/agent-core/tools';
import { getCustomAgent, getCustomAgents, getSessions } from '@remote-swe-agents/agent-core/lib';
import AgentIconPreview from '../components/AgentIconPreview';
import AgentBadges from '../components/AgentBadges';
import AgentDetailCard from './components/AgentDetailCard';
import SubAgentList from './components/SubAgentList';
import LocalDateTime from '@/components/LocalDateTime';
import { toInitialMessagePreview } from '@/lib/session-list';

export const dynamic = 'force-dynamic';

const RECENT_SESSIONS_SCAN_LIMIT = 200;
const RECENT_SESSIONS_DISPLAY_LIMIT = 5;

export default async function CustomAgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const t = await getTranslations('customAgent');

  const [availableTools, agent, allAgents, recentSessions] = await Promise.all([
    Promise.all(
      optionalTools.map(async (tool) => ({
        name: tool.name,
        description: (await tool.toolSpec()).description?.trim() ?? '',
      }))
    ),
    getCustomAgent(agentId),
    getCustomAgents(),
    getSessions(RECENT_SESSIONS_SCAN_LIMIT),
  ]);

  if (!agent) {
    notFound();
  }

  const childAgents = allAgents.filter((a) => a.parentAgentId === agent.SK);
  const agentSessions = recentSessions.filter((s) => s.customAgentId === agent.SK);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <HeaderWithPreferences />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6 pt-20">
        <div className="mb-4">
          <Link
            href="/custom-agent"
            className="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            {t('detail.backToList')}
          </Link>
        </div>

        <div className="mb-6">
          <div className="flex items-center gap-3 flex-wrap mb-2">
            <AgentIconPreview iconKey={agent.iconKey} size={40} />
            <h1 className="text-3xl font-bold">{agent.name}</h1>
            <AgentBadges agent={agent} subAgentsCount={childAgents.length} />
          </div>
          <p className="text-gray-600 dark:text-gray-400">{agent.description}</p>
        </div>

        <div className="space-y-6">
          <AgentDetailCard agent={agent} childAgents={childAgents} availableTools={availableTools} />

          <div className="border border-gray-200 dark:border-gray-800 shadow-sm rounded-lg bg-white dark:bg-gray-800">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-xl font-semibold mb-1">{t('detail.usage.title')}</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('detail.usage.description')}</p>
            </div>
            <div className="p-6">
              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-3xl font-bold">{agentSessions.length}</span>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {t('detail.usage.recentSessionCount', { limit: RECENT_SESSIONS_SCAN_LIMIT })}
                </span>
              </div>
              {agentSessions.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('detail.usage.recentSessions')}
                  </p>
                  {agentSessions.slice(0, RECENT_SESSIONS_DISPLAY_LIMIT).map((session) => (
                    <Link
                      key={session.workerId}
                      href={`/sessions/${encodeURIComponent(session.workerId)}`}
                      className="flex justify-between items-center gap-2 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                    >
                      <span className="text-sm truncate">
                        {session.title || toInitialMessagePreview(session.initialMessage)}
                      </span>
                      <span className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className={`px-2 py-0.5 text-xs rounded ${
                            session.agentStatus === 'completed'
                              ? 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200'
                              : session.agentStatus === 'working'
                                ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200'
                                : 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200'
                          }`}
                        >
                          {session.agentStatus}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline">
                          <LocalDateTime timestamp={session.createdAt} format="date" />
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('detail.usage.noSessions')}</p>
              )}
            </div>
          </div>

          <div className="border border-gray-200 dark:border-gray-800 shadow-sm rounded-lg bg-white dark:bg-gray-800">
            <div className="p-6 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-xl font-semibold mb-1">{t('detail.subAgents.title')}</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('detail.subAgents.description', { name: agent.name })}
              </p>
            </div>
            <div className="p-6">
              <SubAgentList subAgents={childAgents} availableTools={availableTools} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
