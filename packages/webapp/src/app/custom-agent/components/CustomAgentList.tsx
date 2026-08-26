import Link from 'next/link';
import { ChevronRightIcon } from 'lucide-react';
import type { CustomAgent } from '@remote-swe-agents/agent-core/schema';
import AgentIconPreview from './AgentIconPreview';
import AgentBadges from './AgentBadges';
import DuplicateAgentButton from './DuplicateAgentButton';
import LocalDateTime from '@/components/LocalDateTime';

type CustomAgentListProps = {
  agents: CustomAgent[];
  subAgentCounts: Record<string, number>;
};

export default function CustomAgentList({ agents, subAgentCounts }: CustomAgentListProps) {
  return (
    <div className="space-y-4">
      {agents.map((agent) => (
        <Link
          key={agent.SK}
          href={`/custom-agent/${encodeURIComponent(agent.SK)}`}
          className="block border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
        >
          <div className="p-4">
            <div className="flex justify-between items-start mb-2 gap-2">
              <div className="flex items-center gap-3 flex-wrap min-w-0">
                <AgentIconPreview iconKey={agent.iconKey} size={32} />
                <h3 className="text-lg font-semibold">{agent.name}</h3>
                <AgentBadges agent={agent} subAgentsCount={subAgentCounts[agent.SK]} />
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline">
                  <LocalDateTime timestamp={agent.createdAt} format="date" />
                </span>
                <DuplicateAgentButton agentId={agent.SK} />
                <ChevronRightIcon className="h-4 w-4 text-gray-500" />
              </div>
            </div>
            <p className="text-gray-600 dark:text-gray-400">{agent.description}</p>
          </div>
        </Link>
      ))}
    </div>
  );
}
