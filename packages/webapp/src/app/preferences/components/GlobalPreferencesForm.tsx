'use client';

import { toast } from 'sonner';
import { useOptimisticAction } from 'next-safe-action/hooks';
import { useTranslations } from 'next-intl';
import { updateGlobalPreferences } from '../actions';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import AgentIconUploader from '@/components/AgentIconUploader';
import {
  GlobalPreferences,
  ModelType,
  getAvailableModelTypes,
  modelConfigs,
} from '@remote-swe-agents/agent-core/schema';
import { useState } from 'react';

interface GlobalPreferencesFormProps {
  preference: GlobalPreferences;
}

export default function GlobalPreferencesForm({ preference }: GlobalPreferencesFormProps) {
  const t = useTranslations('preferences');
  const [currentPreference, setCurrentPreference] = useState<GlobalPreferences>(preference);
  const [agentName, setAgentName] = useState(preference.defaultAgentName || '');

  const { execute, optimisticState, isPending } = useOptimisticAction(updateGlobalPreferences, {
    currentState: {
      modelOverride: currentPreference.modelOverride,
      enableLinkInPr: currentPreference.enableLinkInPr,
      defaultAgentName: currentPreference.defaultAgentName,
      defaultAgentIconKey: currentPreference.defaultAgentIconKey,
    },
    updateFn: (state, input) => ({
      modelOverride: input.modelOverride || state.modelOverride,
      enableLinkInPr: input.enableLinkInPr ?? state.enableLinkInPr,
      defaultAgentName: input.defaultAgentName ?? state.defaultAgentName,
      defaultAgentIconKey: input.defaultAgentIconKey ?? state.defaultAgentIconKey,
    }),
    onSuccess: ({ data }) => {
      toast.success(t('updateSuccess'));
      setCurrentPreference(data);
    },
    onError: () => {
      toast.error(t('updateError'));
    },
  });

  return (
    <div className="space-y-6">
      {/* Default Agent Name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('defaultAgentName')}
        </label>
        <div className="flex gap-2">
          <Input
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder={t('defaultAgentNamePlaceholder')}
            disabled={isPending}
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => execute({ defaultAgentName: agentName })}
            disabled={isPending || agentName === (currentPreference.defaultAgentName || '')}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 rounded-md transition-colors"
          >
            {t('save')}
          </button>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('defaultAgentNameDescription')}</p>
      </div>

      {/* Default Agent Icon */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('defaultAgentIcon')}
        </label>
        <AgentIconUploader
          currentIconKey={currentPreference.defaultAgentIconKey || undefined}
          onIconKeyChange={(key) => execute({ defaultAgentIconKey: key })}
          disabled={isPending}
        />
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('defaultAgentIconDescription')}</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('defaultModel')}</label>
        <Select
          defaultValue={optimisticState.modelOverride}
          onValueChange={(value: ModelType) => execute({ modelOverride: value })}
          disabled={isPending}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a model" />
            {isPending && (
              <div className="ml-2 animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-gray-600"></div>
            )}
          </SelectTrigger>
          <SelectContent>
            {getAvailableModelTypes().map((type) => (
              <SelectItem key={type} value={type}>
                {modelConfigs[type].name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('defaultModelDescription')}</p>
      </div>

      <div>
        <div className="flex items-center space-x-3">
          <Checkbox
            id="enableLinkInPr"
            checked={optimisticState.enableLinkInPr}
            onCheckedChange={(checked) => execute({ enableLinkInPr: !!checked })}
            disabled={isPending}
          />
          <label htmlFor="enableLinkInPr" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('enableLinkInPr')}
          </label>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('enableLinkInPrDescription')}</p>
      </div>
    </div>
  );
}
