'use client';

import { toast } from 'sonner';
import { useOptimisticAction } from 'next-safe-action/hooks';
import { useAction } from 'next-safe-action/hooks';
import { useTranslations } from 'next-intl';
import {
  updateGlobalPreferences,
  saveKiroApiKeyAction,
  deleteKiroApiKeyAction,
  checkKiroApiKeyAction,
  updateUserPreferencesAction,
  getUserPreferencesAction,
} from '../actions';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { TrashIcon, KeyIcon, CheckIcon } from 'lucide-react';
import AgentIconUploader from '@/components/AgentIconUploader';
import {
  GlobalPreferences,
  InferenceMode,
  ModelType,
  KiroModelId,
  getAvailableModelTypes,
  getKiroModelIds,
  modelConfigs,
  kiroModelConfigs,
} from '@remote-swe-agents/agent-core/schema';
import { useState, useEffect } from 'react';

interface GlobalPreferencesFormProps {
  preference: GlobalPreferences;
}

// Map internal inference mode identifiers to i18n translation keys.
// The mode value `'kiro-cli'` is an implementation detail; the user-facing
// translation key is `'kiro'`.
const inferenceModeI18nKey: Record<InferenceMode, string> = {
  bedrock: 'bedrock',
  'kiro-cli': 'kiro',
};

export default function GlobalPreferencesForm({ preference }: GlobalPreferencesFormProps) {
  const t = useTranslations('preferences');
  const [currentPreference, setCurrentPreference] = useState<GlobalPreferences>(preference);
  const [agentName, setAgentName] = useState(preference.defaultAgentName || '');

  // Per-user Kiro settings. `savedMode` is the server-authoritative default
  // inference mode for new sessions. `hasApiKey` reflects whether a Kiro API
  // key is stored; it is independent from the mode selection.
  const [savedMode, setSavedMode] = useState<InferenceMode>('bedrock');
  const [kiroModel, setKiroModel] = useState<KiroModelId>('auto');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);

  // Global preferences optimistic action
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
    onError: () => toast.error(t('updateError')),
  });

  // Per-user preferences fetcher — used as the source of truth after mutations.
  const { execute: execGetUserPrefs } = useAction(getUserPreferencesAction, {
    onSuccess: ({ data }) => {
      if (data) {
        if (data.inferenceMode) setSavedMode(data.inferenceMode);
        if (data.kiroDefaultModel) setKiroModel(data.kiroDefaultModel as KiroModelId);
        else if (data.kiroModel) setKiroModel(data.kiroModel as KiroModelId);
      }
    },
  });

  // Optimistic mode switch with rollback via refetch on error.
  const {
    execute: execUpdateMode,
    optimisticState: optimisticMode,
    isPending: isUpdatingMode,
  } = useOptimisticAction(updateUserPreferencesAction, {
    currentState: { mode: savedMode },
    updateFn: (_state, input) => ({ mode: (input.inferenceMode ?? _state.mode) as InferenceMode }),
    onSuccess: ({ input }) => {
      if (input.inferenceMode) setSavedMode(input.inferenceMode);
      toast.success(t('inferenceModeUpdateSuccess'));
    },
    onError: () => {
      toast.error(t('inferenceModeUpdateError'));
      // Rollback local state from server.
      execGetUserPrefs({});
    },
  });

  // Non-mode user-pref updates (e.g. kiroModel).
  const { execute: execUpdateUserPrefs, isPending: isUpdatingUserPrefs } = useAction(updateUserPreferencesAction, {
    onSuccess: () => toast.success(t('updateSuccess')),
    onError: () => toast.error(t('updateError')),
  });

  // API key save — pure save, no mode mutation. Refetch to resync authoritative state.
  const { execute: execSaveKey, isPending: isSavingKey } = useAction(saveKiroApiKeyAction, {
    onSuccess: () => {
      toast.success(t('kiroApiKeySaveSuccess'));
      setApiKeyInput('');
      setHasApiKey(true);
      execCheckKey({});
    },
    onError: () => toast.error(t('kiroApiKeySaveError')),
  });

  // API key delete — pure delete, no mode mutation. Refetch to resync.
  const { execute: execDeleteKey, isPending: isDeletingKey } = useAction(deleteKiroApiKeyAction, {
    onSuccess: () => {
      toast.success(t('kiroApiKeyDeleteSuccess'));
      setHasApiKey(false);
      execCheckKey({});
    },
    onError: () => toast.error(t('kiroApiKeyDeleteError')),
  });

  const { execute: execCheckKey } = useAction(checkKiroApiKeyAction, {
    onSuccess: ({ data }) => {
      if (data) setHasApiKey(data.hasKey);
    },
  });

  useEffect(() => {
    execCheckKey({});
    execGetUserPrefs({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const kiroModelIds = getKiroModelIds();
  const selectedMode = optimisticMode.mode;

  // Mode switching and API key save/delete are independent actions by design.
  // We intentionally allow switching to Kiro before an API key is
  // configured so the user can pick the mode first and then enter the key in
  // the section that appears below.
  const handleSelectMode = (mode: InferenceMode) => {
    if (mode === selectedMode) return;
    execUpdateMode({ inferenceMode: mode });
  };

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

      {/* Default Inference Mode — Segment Control.
          This is the user-level default used as the initial value when
          creating new sessions. It is not coupled to API key save/delete.
          Switching to Kiro is allowed before an API key is configured so the
          user can follow the natural flow (pick Kiro → enter key → save). */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('inferenceMode')}</label>
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-100 dark:bg-gray-800">
          {(['bedrock', 'kiro-cli'] as const).map((mode) => {
            const isActive = selectedMode === mode;
            const isDisabled = isUpdatingMode;
            return (
              <button
                key={mode}
                type="button"
                disabled={isDisabled}
                onClick={() => handleSelectMode(mode)}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  isActive
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                } ${isDisabled && !isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {t(`inferenceModes.${inferenceModeI18nKey[mode]}`)}
              </button>
            );
          })}
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('inferenceModeDescription')}</p>
        {selectedMode === 'kiro-cli' && !hasApiKey && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mt-1">{t('kiroApiKeyRequired')}</p>
        )}
      </div>

      {/* Kiro API Key — only visible when the default inference mode is Kiro.
          Saving and deleting the API key remain independent from mode
          switching, so this conditional render does not re-introduce a race
          between "key is saved" and "mode is switched". */}
      {selectedMode === 'kiro-cli' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            <KeyIcon className="inline h-4 w-4 mr-1" />
            {t('kiroApiKey')}
          </label>
          {hasApiKey ? (
            <div className="flex items-center gap-3">
              <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md">
                <CheckIcon className="h-4 w-4 text-green-600 dark:text-green-400" />
                <span className="text-sm text-green-700 dark:text-green-300">
                  {t('kiroApiKeyConfigured')} (••••••••)
                </span>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (window.confirm(t('kiroApiKeyDeleteConfirm'))) execDeleteKey({});
                }}
                disabled={isDeletingKey}
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={t('kiroApiKeyPlaceholder')}
                disabled={isSavingKey}
                className="flex-1"
              />
              <Button
                type="button"
                onClick={() => execSaveKey({ apiKey: apiKeyInput })}
                disabled={isSavingKey || !apiKeyInput}
              >
                {isSavingKey ? '...' : t('save')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Bedrock Model — shown when the selected default mode is Bedrock. */}
      {selectedMode === 'bedrock' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('defaultModel')}</label>
          <Select
            defaultValue={optimisticState.modelOverride}
            onValueChange={(value: ModelType) => execute({ modelOverride: value })}
            disabled={isPending}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a model" />
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
      )}

      {/* Kiro Model — shown when the selected default mode is Kiro and a key is set. */}
      {selectedMode === 'kiro-cli' && hasApiKey && (
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('kiroModel')}</label>
          <Select
            value={kiroModel}
            onValueChange={(value) => {
              const modelId = value as KiroModelId;
              setKiroModel(modelId);
              execUpdateUserPrefs({ kiroModel: modelId, kiroDefaultModel: modelId });
            }}
            disabled={isUpdatingUserPrefs}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kiroModelIds.map((model) => (
                <SelectItem key={model} value={model}>
                  {kiroModelConfigs[model]?.name ?? model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('kiroModelDescription')}</p>
        </div>
      )}

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
