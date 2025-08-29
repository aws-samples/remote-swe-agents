import Header from '@/components/Header';
import { getTranslations } from 'next-intl/server';
import CustomAgentForm from './components/CustomAgentForm';
import PreferenceSection from '../preferences/components/PreferenceSection';
import {
  cloneRepositoryTool,
  fileEditTool,
  readImageTool,
  ciTool,
  commandExecutionTool,
  createPRTool,
} from '@remote-swe-agents/agent-core/tools';
import { getCustomAgents } from '@remote-swe-agents/agent-core/lib';
import type { CustomAgent } from '@remote-swe-agents/agent-core/schema';
import { mcpConfigSchema } from '@remote-swe-agents/agent-core/schema';

export const dynamic = 'force-dynamic';

export default async function CustomAgentPage() {
  const t = await getTranslations('customAgent');
  const [availableTools, customAgents] = await Promise.all([
    Promise.all(
      [
        // We do not expose internal tools such as todoList tools.
        fileEditTool,
        readImageTool,
        cloneRepositoryTool,
        createPRTool,
        ciTool,
        commandExecutionTool,
      ].map(async (tool) => ({
        name: tool.name,
        description: (await tool.toolSpec()).description?.trim() ?? '',
      }))
    ),
    getCustomAgents()
  ]);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6 pt-20">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">{t('title')}</h1>
          <p className="text-gray-600 dark:text-gray-400">{t('description')}</p>
        </div>

        <div className="space-y-6">
          {customAgents.length > 0 && (
            <PreferenceSection title={t('list.title')} description={t('list.description')}>
              <div className="space-y-4">
                {customAgents.map((agent: CustomAgent) => {
                  let mcpServersCount = 0;
                  try {
                    const parsedMcpConfig = mcpConfigSchema.parse(JSON.parse(agent.mcpConfig));
                    mcpServersCount = Object.keys(parsedMcpConfig.mcpServers).length;
                  } catch {
                    // Ignore parsing errors
                  }

                  return (
                    <div key={agent.SK} className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
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
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {new Date(agent.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-gray-600 dark:text-gray-400">{agent.description}</p>
                    </div>
                  );
                })}
              </div>
            </PreferenceSection>
          )}
          
          <PreferenceSection title={t('create.title')} description={t('create.description')}>
            <CustomAgentForm availableTools={availableTools} />
          </PreferenceSection>
        </div>
      </main>
    </div>
  );
}
