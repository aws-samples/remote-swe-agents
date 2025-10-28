'use client';

import { toast } from 'sonner';
import { useOptimisticAction } from 'next-safe-action/hooks';
import { useTranslations } from 'next-intl';
import { updateGlobalPreferences } from '../actions';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  GlobalPreferences,
  ModelType,
  getAvailableModelTypes,
  modelConfigs,
} from '@remote-swe-agents/agent-core/schema';

interface GlobalPreferencesFormProps {
  preference: GlobalPreferences;
}

export default function GlobalPreferencesForm({ preference }: GlobalPreferencesFormProps) {
  const t = useTranslations('preferences');

  const { execute, optimisticState, isPending } = useOptimisticAction(updateGlobalPreferences, {
    currentState: { modelOverride: preference.modelOverride, enableLinkInPr: preference.enableLinkInPr },
    updateFn: (state, input) => ({
      modelOverride: input.modelOverride || state.modelOverride,
      enableLinkInPr: input.enableLinkInPr ?? state.enableLinkInPr,
    }),
    onSuccess: () => {
      toast.success(t('updateSuccess'));
    },
    onError: () => {
      toast.error(t('updateError'));
    },
  });

  return (
    <div className="space-y-4">
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
