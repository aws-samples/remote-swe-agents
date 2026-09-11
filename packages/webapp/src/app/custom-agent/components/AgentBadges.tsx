import type { CustomAgent } from '@remote-swe-agents/agent-core/schema';
import { mcpConfigSchema } from '@remote-swe-agents/agent-core/schema';

export function mcpServersCount(agent: CustomAgent): number {
  try {
    const parsed = mcpConfigSchema.parse(JSON.parse(agent.mcpConfig));
    return Object.keys(parsed.mcpServers).length;
  } catch {
    return 0;
  }
}

export function effectiveModel(agent: CustomAgent): string {
  if (agent.inferenceMode === 'kiro-cli') return agent.kiroDefaultModel ?? agent.kiroModel ?? 'auto';
  return agent.bedrockDefaultModel ?? agent.defaultModel;
}

export function inferenceModeLabel(mode: CustomAgent['inferenceMode']): string {
  if (mode === 'bedrock') return 'Bedrock';
  if (mode === 'kiro-cli') return 'Kiro';
  return 'Default';
}

export default function AgentBadges({ agent, subAgentsCount }: { agent: CustomAgent; subAgentsCount?: number }) {
  const mcpCount = mcpServersCount(agent);
  return (
    <div className="flex gap-2 flex-wrap">
      {agent.inferenceMode && (
        <span className="px-2 py-1 text-xs bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200 rounded">
          {inferenceModeLabel(agent.inferenceMode)}
        </span>
      )}
      <span className="px-2 py-1 text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded">
        {effectiveModel(agent)}
      </span>
      <span className="px-2 py-1 text-xs bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
        {agent.runtimeType}
      </span>
      <span className="px-2 py-1 text-xs bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 rounded">
        Tools: {agent.useAllTools ? 'All' : agent.tools.length}
      </span>
      {mcpCount > 0 && (
        <span className="px-2 py-1 text-xs bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200 rounded">
          MCP: {mcpCount}
        </span>
      )}
      {subAgentsCount !== undefined && subAgentsCount > 0 && (
        <span className="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded">
          Sub-agents: {subAgentsCount}
        </span>
      )}
    </div>
  );
}
