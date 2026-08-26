'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import type { CustomAgent } from '@remote-swe-agents/agent-core/schema';
import AgentIconPreview from '../../components/AgentIconPreview';
import AgentBadges from '../../components/AgentBadges';
import DuplicateAgentButton from '../../components/DuplicateAgentButton';
import CustomAgentForm from '../../components/CustomAgentForm';
import LocalDateTime from '@/components/LocalDateTime';

type SubAgentListProps = {
  subAgents: CustomAgent[];
  availableTools: { name: string; description: string }[];
};

export default function SubAgentList({ subAgents, availableTools }: SubAgentListProps) {
  const t = useTranslations('customAgent');
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  if (subAgents.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('detail.subAgents.empty')}</p>;
  }

  return (
    <div className="space-y-4">
      {subAgents.map((agent) => (
        <div
          key={agent.SK}
          className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
        >
          <div
            className="p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
            onClick={() => setExpandedAgentId(expandedAgentId === agent.SK ? null : agent.SK)}
          >
            <div className="flex justify-between items-start mb-2 gap-2">
              <div className="flex items-center gap-3 flex-wrap min-w-0">
                <AgentIconPreview iconKey={agent.iconKey} size={32} />
                <h3 className="text-lg font-semibold">{agent.name}</h3>
                <AgentBadges agent={agent} />
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline">
                  <LocalDateTime timestamp={agent.createdAt} format="date" />
                </span>
                <DuplicateAgentButton agentId={agent.SK} />
                {expandedAgentId === agent.SK ? (
                  <ChevronUpIcon className="h-4 w-4 text-gray-500" />
                ) : (
                  <ChevronDownIcon className="h-4 w-4 text-gray-500" />
                )}
              </div>
            </div>
            <p className="text-gray-600 dark:text-gray-400">{agent.description}</p>
          </div>
          {expandedAgentId === agent.SK && (
            <div className="border-t border-gray-200 dark:border-gray-700 p-4">
              <CustomAgentForm
                availableTools={availableTools}
                editingAgent={agent}
                onSuccess={() => setExpandedAgentId(null)}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
