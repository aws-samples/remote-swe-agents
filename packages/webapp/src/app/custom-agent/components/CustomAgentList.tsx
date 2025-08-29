'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import type { CustomAgent } from '@remote-swe-agents/agent-core/schema';
import { mcpConfigSchema } from '@remote-swe-agents/agent-core/schema';
import CustomAgentForm from './CustomAgentForm';

type CustomAgentListProps = {
  initialAgents: CustomAgent[];
  availableTools: { name: string; description: string }[];
};

export default function CustomAgentList({ initialAgents, availableTools }: CustomAgentListProps) {
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);

  const handleCardClick = (agentId: string) => {
    setExpandedAgentId(expandedAgentId === agentId ? null : agentId);
  };

  const handleAgentUpdate = () => {
    // setExpandedAgentId(null);
    // TODO: Refresh agents list
  };

  return (
    <div className="space-y-4">
      {initialAgents.map((agent: CustomAgent) => {
        let mcpServersCount = 0;
        try {
          const parsedMcpConfig = mcpConfigSchema.parse(JSON.parse(agent.mcpConfig));
          mcpServersCount = Object.keys(parsedMcpConfig.mcpServers).length;
        } catch {
          // Ignore parsing errors
        }

        return (
          <div key={agent.SK} className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
            <div 
              className="p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
              onClick={() => handleCardClick(agent.SK)}
            >
              <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <h3 className="text-lg font-semibold">{agent.name}</h3>
                  <div className="flex gap-2 flex-wrap">
                    <span className="px-2 py-1 text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded">
                      {agent.defaultModel}
                    </span>
                    <span className="px-2 py-1 text-xs bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
                      {agent.runtimeType}
                    </span>
                    <span className="px-2 py-1 text-xs bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 rounded">
                      Tools: {agent.tools.length}
                    </span>
                    {mcpServersCount > 0 && (
                      <span className="px-2 py-1 text-xs bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 rounded">
                        MCP: {mcpServersCount}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {new Date(agent.createdAt).toLocaleDateString()}
                  </span>
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
                  onSuccess={handleAgentUpdate}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
