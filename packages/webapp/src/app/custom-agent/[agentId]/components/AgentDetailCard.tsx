'use client';

import { useState } from 'react';
import { useAction } from 'next-safe-action/hooks';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PencilIcon, TrashIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CustomAgent } from '@remote-swe-agents/agent-core/schema';
import { modelConfigs, kiroModelConfigs } from '@remote-swe-agents/agent-core/schema';
import type { KiroModelId } from '@remote-swe-agents/agent-core/schema';
import CustomAgentForm from '../../components/CustomAgentForm';
import DuplicateAgentButton from '../../components/DuplicateAgentButton';
import { deleteCustomAgentAction } from '../../actions';
import { mcpServersCount } from '../../components/AgentBadges';
import LocalDateTime from '@/components/LocalDateTime';

type AgentDetailCardProps = {
  agent: CustomAgent;
  childAgents: CustomAgent[];
  availableTools: { name: string; description: string }[];
};

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export default function AgentDetailCard({ agent, childAgents, availableTools }: AgentDetailCardProps) {
  const t = useTranslations('customAgent');
  const router = useRouter();
  const [editing, setEditing] = useState(false);

  // The server action redirects to the list on success (NEXT_REDIRECT), so
  // onSuccess does not run here and the deleteSuccess toast is shown by the
  // list page. Only onError runs client-side.
  const { execute: deleteAgent, isPending: isDeleting } = useAction(deleteCustomAgentAction, {
    onError: ({ error }) => {
      const errorMessage = typeof error === 'string' ? error : t('deleteError');
      toast.error(errorMessage);
    },
  });

  const handleDelete = () => {
    const message =
      childAgents.length > 0
        ? t('form.confirmDeleteWithChildren', {
            count: childAgents.length,
            names: childAgents.map((c) => c.name).join(', '),
          })
        : t('form.confirmDelete');
    if (window.confirm(message)) {
      // Delete the agent that owns this route: let the server redirect to the
      // list so the revalidate/notFound race cannot flash a 404.
      deleteAgent({ id: agent.SK, redirectToListOnSuccess: true });
    }
  };

  const activeMark = <span className="text-xs text-blue-600 dark:text-blue-400 ml-1">{t('detail.activeModel')}</span>;
  const bedrockModelId = agent.bedrockDefaultModel ?? agent.defaultModel;
  const kiroModelId = (agent.kiroDefaultModel ??
    (agent.kiroModel && agent.kiroModel in kiroModelConfigs ? agent.kiroModel : 'auto')) as KiroModelId;
  const mcpCount = mcpServersCount(agent);

  return (
    <div className="border border-gray-200 dark:border-gray-800 shadow-sm rounded-lg bg-white dark:bg-gray-800">
      <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex justify-between items-start gap-2 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold mb-1">{t('detail.title')}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('detail.description')}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <DuplicateAgentButton agentId={agent.SK} variant="labeled" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing(!editing)}
            className="flex items-center gap-1.5"
          >
            <PencilIcon className="h-4 w-4" />
            {t('detail.edit')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isDeleting}
            onClick={handleDelete}
            className="flex items-center gap-1.5 text-red-600 dark:text-red-400"
          >
            <TrashIcon className="h-4 w-4" />
            {t('form.delete')}
          </Button>
        </div>
      </div>

      <div className="p-6">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <DetailRow label={t('form.inferenceMode.label')}>
            {agent.inferenceMode === 'bedrock'
              ? t('form.inferenceMode.bedrock')
              : agent.inferenceMode === 'kiro-cli'
                ? t('form.inferenceMode.kiro')
                : t('form.inferenceMode.inherit')}
          </DetailRow>
          <DetailRow label={t('form.bedrockModel.label')}>
            {modelConfigs[bedrockModelId]?.name ?? bedrockModelId}
            {agent.inferenceMode === 'bedrock' && activeMark}
          </DetailRow>
          <DetailRow label={t('form.kiroModel.label')}>
            {kiroModelConfigs[kiroModelId]?.name ?? kiroModelId}
            {agent.inferenceMode === 'kiro-cli' && activeMark}
          </DetailRow>
          <DetailRow label={t('form.runtimeType.label')}>
            {agent.runtimeType === 'agent-core' ? 'AgentCore Runtime' : 'EC2'}
          </DetailRow>
          <DetailRow label={t('form.tools.label')}>
            {agent.useAllTools ? (
              t('detail.allToolsEnabled')
            ) : (
              <>
                {t('detail.toolsSelected', { count: agent.tools.length })}
                {agent.tools.length > 0 && (
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">{agent.tools.join(', ')}</span>
                )}
              </>
            )}
          </DetailRow>
          <DetailRow label={t('form.mcpConfig.label')}>
            {mcpCount > 0 ? t('detail.mcpConfigured', { count: mcpCount }) : t('detail.mcpNone')}
          </DetailRow>
          <DetailRow label={t('form.systemPrompt.includeDefaultKnowledgeShort')}>
            {agent.includeDefaultKnowledge === false ? t('detail.excluded') : t('detail.included')}
          </DetailRow>
          <DetailRow label={t('detail.createdAt')}>
            <LocalDateTime timestamp={agent.createdAt} format="date" />
          </DetailRow>
        </dl>

        {agent.systemPrompt && (
          <div className="mt-4">
            <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
              {t('form.systemPrompt.label')}
            </dt>
            <dd className="text-sm bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-md p-3 text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
              {agent.systemPrompt}
            </dd>
          </div>
        )}

        {mcpCount > 0 && (
          <div className="mt-4">
            <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">{t('form.mcpConfig.label')}</dt>
            <dd className="text-sm bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-md p-3 text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-mono overflow-x-auto">
              {agent.mcpConfig}
            </dd>
          </div>
        )}
      </div>

      {editing && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-6">
          <CustomAgentForm
            availableTools={availableTools}
            editingAgent={agent}
            childAgents={childAgents}
            onSuccess={() => setEditing(false)}
            onDeleted={() => router.push('/custom-agent')}
          />
        </div>
      )}
    </div>
  );
}
