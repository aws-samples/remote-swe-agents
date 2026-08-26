'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { useAction } from 'next-safe-action/hooks';
import { Button } from '@/components/ui/button';
import { Paperclip, FileText } from 'lucide-react';
import Link from 'next/link';
import { createNewWorker } from './actions';
import { createNewWorkerSchema, PromptTemplate } from './schemas';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useImageUploader } from '@/components/ImageUploader';
import {
  clearStaleDeploymentReloadGuard,
  isChunkLoadError,
  isStaleActionError,
  reloadForStaleDeployment,
} from '@/lib/deployment-recovery';
import { extractStringArray, salvageOptionalFields, savePendingResend, takePendingResend } from '@/lib/pending-resend';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField } from '@/components/ui/form';
import { useState, useEffect, useMemo, useRef } from 'react';
import { getUserPreferencesAction, checkKiroApiKeyAction } from '../../preferences/actions';
import TemplateModal from './TemplateModal';
import {
  CustomAgent,
  InferenceMode,
  KiroModelId,
  getAvailableModelTypes,
  GlobalPreferences,
  modelConfigs,
  kiroModelConfigs,
  getKiroModelIds,
} from '@remote-swe-agents/agent-core/schema';

interface NewSessionFormProps {
  templates: PromptTemplate[];
  customAgents: CustomAgent[];
  preferences: GlobalPreferences;
  agentIconUrls?: Record<string, string>;
  kiroModel: string;
}

// Map internal inference mode identifiers to i18n translation keys.
const inferenceModeI18nKey: Record<InferenceMode, string> = {
  bedrock: 'bedrock',
  'kiro-cli': 'kiro',
};

export default function NewSessionForm({
  templates,
  customAgents,
  preferences,
  agentIconUrls = {},
  kiroModel: ssrKiroModel,
}: NewSessionFormProps) {
  const t = useTranslations('new_session');
  const sessionsT = useTranslations('sessions');
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [userDefaultMode, setUserDefaultMode] = useState<InferenceMode>('bedrock');

  const { execute: execGetUserPrefs } = useAction(getUserPreferencesAction, {
    onSuccess: ({ data }) => {
      if (!data) return;
      if (data.inferenceMode) setUserDefaultMode(data.inferenceMode);
    },
  });
  const { execute: execCheckKey } = useAction(checkKiroApiKeyAction, {
    onSuccess: ({ data }) => {
      if (data) setHasApiKey(data.hasKey);
    },
  });

  useEffect(() => {
    execGetUserPrefs({});
    execCheckKey({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    form,
    action: { isPending },
    handleSubmitWithAction,
  } = useHookFormAction(createNewWorker, zodResolver(createNewWorkerSchema), {
    actionProps: {
      onSuccess: (args) => {},
      // Successful creation ends in a redirect(), which surfaces as a
      // navigation (onSuccess is not called) — reset the stale-deployment
      // reload attempt counter here.
      onNavigation: () => {
        try {
          clearStaleDeploymentReloadGuard(window.sessionStorage);
        } catch {}
      },
      onError: ({ error }) => {
        // Stale build after a redeploy. UnrecognizedActionError means the
        // Server Action was rejected before executing, so it is safe to
        // reload and automatically re-submit (mode 'resend'). ChunkLoadError
        // gives no such guarantee — resubmitting could create a second
        // session — so the form content is only restored after the reload
        // (mode 'restore'). Loop-guarded — see deployment-recovery.ts.
        const staleAction = isStaleActionError(error.thrownError);
        if (staleAction || isChunkLoadError(error.thrownError)) {
          savePendingResend('new-session', {
            mode: staleAction ? 'resend' : 'restore',
            values: form.getValues(),
          });
          if (reloadForStaleDeployment()) {
            return;
          }
          takePendingResend('new-session');
        }
        if (resendAttachmentsRef.current) {
          const { imageKeys, fileKeys } = resendAttachmentsRef.current;
          resendAttachmentsRef.current = null;
          void restoreFromKeysRef.current(imageKeys, fileKeys);
        }
        toast.error(typeof error === 'string' ? error : 'Failed to create session');
      },
    },
    formProps: {
      defaultValues: {
        message: '',
        imageKeys: [],
        fileKeys: [],
        modelOverride: preferences.modelOverride,
        customAgentId: 'DEFAULT',
        inferenceMode: 'bedrock',
        kiroModel: ssrKiroModel as KiroModelId,
      },
    },
  });
  const { register, formState, setValue, watch, control } = form;

  const resendAttachmentsRef = useRef<{ imageKeys: string[]; fileKeys: string[] } | null>(null);
  const restoreFromKeysRef = useRef<
    (imageKeys: string[], fileKeys: string[]) => Promise<{ imageKeys: string[]; fileKeys: string[] } | null>
  >(async () => null);

  // Consume a pending submission persisted by the stale-deployment handler
  // above (one-shot: the payload is removed from sessionStorage before
  // acting). Values crossing a deployment boundary are re-validated against
  // the NEW build's schema field by field; only the fields that are actually
  // invalid (model enums change between deploys) are dropped — with a toast —
  // and if the payload cannot be auto-resent it degrades to restoring the
  // form so the user's input is never lost.
  const resendConsumedRef = useRef(false);
  useEffect(() => {
    if (resendConsumedRef.current) return;
    resendConsumedRef.current = true;
    const pending = takePendingResend<Record<string, unknown>>('new-session');
    if (!pending) return;
    const raw = pending.values;
    const message = typeof raw.message === 'string' ? raw.message : '';
    if (!message.trim()) return;
    const imageKeys = extractStringArray(raw.imageKeys);
    const fileKeys = extractStringArray(raw.fileKeys);
    const { values: optionals, dropped } = salvageOptionalFields(createNewWorkerSchema.shape, raw, [
      'modelOverride',
      'customAgentId',
      'inferenceMode',
      'kiroModel',
      'bedrockDefaultModel',
      'kiroDefaultModel',
    ]);
    const parsed = createNewWorkerSchema.safeParse({ message, imageKeys, fileKeys, ...optionals });
    const canResend = pending.mode === 'resend' && parsed.success;
    const values = parsed.success ? parsed.data : { message, imageKeys, fileKeys };
    resendAttachmentsRef.current = { imageKeys, fileKeys };
    requestAnimationFrame(() => {
      const defined = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
      form.reset({ ...form.getValues(), ...defined });
      if (dropped.length > 0) {
        toast.warning(sessionsT('settingsNotCarriedOver'));
      }
      if (canResend) {
        toast.info(sessionsT('reloadedAfterUpdate'));
        handleSubmitWithAction();
      } else {
        resendAttachmentsRef.current = null;
        void restoreFromKeysRef.current(imageKeys, fileKeys);
        toast.info(sessionsT('messageRestoredAfterUpdate'));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedCustomAgentId = watch('customAgentId');
  const inferenceMode = watch('inferenceMode') ?? 'bedrock';
  const kiroModel = watch('kiroModel') ?? 'auto';

  // Resolve the custom agent currently selected, if any.
  const selectedCustomAgent = useMemo(
    () => customAgents.find((a) => a.SK === selectedCustomAgentId),
    [customAgents, selectedCustomAgentId]
  );

  // A custom agent may pin the inference mode; when it does, the user cannot
  // override it from this form.
  const customAgentForcedMode = selectedCustomAgent?.inferenceMode;
  const isModeLocked = Boolean(customAgentForcedMode);

  // Keep the form's inferenceMode aligned with the effective mode:
  //   1. If a custom agent forces a mode, adopt it.
  //   2. Otherwise, once user preferences load, adopt the user's default
  //      (guarded by API key availability for Kiro).
  useEffect(() => {
    if (customAgentForcedMode) {
      setValue('inferenceMode', customAgentForcedMode);
      return;
    }
    if (userDefaultMode === 'kiro-cli' && !hasApiKey) {
      setValue('inferenceMode', 'bedrock');
      return;
    }
    setValue('inferenceMode', userDefaultMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customAgentForcedMode, userDefaultMode, hasApiKey]);

  // Keep Kiro model in sync when entering Kiro mode.
  useEffect(() => {
    if (inferenceMode === 'kiro-cli') {
      setValue('kiroModel', (ssrKiroModel as KiroModelId) || 'auto');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inferenceMode]);

  const {
    uploadingImages,
    uploadingFiles,
    handleFileSelect,
    handlePaste,
    ImagePreviewList,
    isUploading,
    restoreFromKeys,
  } = useImageUploader({
    onImagesChange: (keys) => {
      setValue('imageKeys', keys);
    },
    onFilesChange: (keys) => {
      setValue('fileKeys', keys);
    },
  });
  restoreFromKeysRef.current = restoreFromKeys;

  const handleTemplateSelect = (template: PromptTemplate) => {
    setValue('message', template.content, { shouldValidate: true });
    setIsTemplateModalOpen(false);
  };

  const handleSelectMode = (mode: InferenceMode) => {
    if (isModeLocked) return;
    if (mode === 'kiro-cli' && !hasApiKey) return;
    setValue('inferenceMode', mode);
    if (mode === 'kiro-cli') {
      setValue('kiroModel', form.getValues('kiroModel') || 'auto');
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={handleSubmitWithAction} className="space-y-6">
        <div className="text-left">
          <ImagePreviewList />

          {/* Custom Agent Selection */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('customAgent')}
            </label>
            <FormField
              name="customAgentId"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                    const agent = customAgents.find((a) => a.SK == value);
                    if (agent) {
                      setValue('modelOverride', agent.bedrockDefaultModel ?? agent.defaultModel);
                    }
                  }}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue>
                        {customAgents.find((a) => a.SK == field.value)?.name ?? t('defaultAgentName')}
                      </SelectValue>
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="DEFAULT">
                      <div className="flex flex-col">
                        <span className="font-medium">{t('defaultAgentName')}</span>
                        <span className="text-sm text-gray-500">{t('defaultAgentDescription')}</span>
                      </div>
                    </SelectItem>
                    {customAgents.map((agent) => (
                      <SelectItem key={agent.SK} value={agent.SK}>
                        <div className="flex items-center gap-2">
                          {agentIconUrls[agent.SK] && (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={agentIconUrls[agent.SK]}
                              alt={agent.name}
                              className="w-5 h-5 rounded-full object-cover flex-shrink-0"
                            />
                          )}
                          <div className="flex flex-col">
                            <span className="font-medium">{agent.name}</span>
                            <span className="text-sm text-gray-500">{agent.description}</span>
                          </div>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {/* Inference Mode toggle */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('inferenceMode')}
            </label>
            <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-100 dark:bg-gray-800 mb-2">
              {(['bedrock', 'kiro-cli'] as const).map((mode) => {
                const isActive = inferenceMode === mode;
                const isDisabled = isPending || isModeLocked || (mode === 'kiro-cli' && !hasApiKey);
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
            {isModeLocked && customAgentForcedMode && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('customAgentForcesMode', {
                  mode: t(`inferenceModes.${inferenceModeI18nKey[customAgentForcedMode]}`),
                })}
              </p>
            )}
            {inferenceMode === 'kiro-cli' && !hasApiKey && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                {t('kiroApiKeyRequired')}{' '}
                <Link href="/preferences" className="underline hover:no-underline">
                  {t('goToPreferences')}
                </Link>
              </p>
            )}
          </div>

          {/* Model selector — separate blocks per mode to avoid React reconciliation issues */}
          {inferenceMode === 'bedrock' && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('modelOverride')}
              </label>
              <FormField
                name="modelOverride"
                control={control}
                render={({ field }) => (
                  <Select value={field.value as string | undefined} onValueChange={field.onChange} disabled={isPending}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {getAvailableModelTypes().map((type) => (
                        <SelectItem key={type} value={type}>
                          {modelConfigs[type].name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          )}
          {inferenceMode === 'kiro-cli' && (
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('modelOverride')}
              </label>
              <FormField
                name="kiroModel"
                control={control}
                render={({ field }) => (
                  <Select value={field.value || 'auto'} onValueChange={field.onChange} disabled={isPending}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Auto (recommended)" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {getKiroModelIds().map((model) => (
                        <SelectItem key={model} value={model}>
                          {kiroModelConfigs[model]?.name ?? model}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          )}

          <div className="flex items-center justify-end mb-2">
            <label
              htmlFor="message"
              className="hidden md:block mr-auto text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('initialMessage')}
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => setIsTemplateModalOpen(true)}
                disabled={isPending}
                size="sm"
                variant="outline"
                className="flex gap-2 items-center"
              >
                <FileText className="w-4 h-4" />
                {t('templates')}
              </Button>
              <Button
                type="button"
                onClick={handleFileSelect}
                disabled={isPending}
                size="sm"
                variant="outline"
                className="flex gap-2 items-center"
              >
                <Paperclip className="w-4 h-4" />
                {uploadingImages.length + uploadingFiles.length > 0
                  ? t('imagesCount', { count: uploadingImages.length + uploadingFiles.length })
                  : sessionsT('attachFile')}
              </Button>
            </div>
          </div>

          <textarea
            id="message"
            {...register('message')}
            placeholder={t('placeholder')}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-200 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
            rows={4}
            disabled={isPending}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                (e.ctrlKey || e.altKey || e.metaKey) &&
                !isPending &&
                formState.isValid &&
                !isUploading
              ) {
                handleSubmitWithAction();
              }
            }}
          />
          {formState.errors.message && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formState.errors.message.message}</p>
          )}
        </div>
        {Object.entries(formState.errors).filter(([field]) => field !== 'message').length > 0 && (
          <p className="mb-2 text-sm text-red-600 dark:text-red-400">
            {Object.entries(formState.errors)
              .filter(([field]) => field !== 'message')
              .map(([field, error]) => `${field}: ${error?.message ?? 'invalid'}`)
              .join(' / ')}
          </p>
        )}
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="submit"
                disabled={isPending || !formState.isValid || isUploading}
                className="w-full"
                size="lg"
              >
                {isPending ? t('creatingSession') : isUploading ? t('waitingForImageUpload') : t('createSessionButton')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{sessionsT('sendWithCtrlEnter')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </form>

      <TemplateModal
        isOpen={isTemplateModalOpen}
        onClose={() => setIsTemplateModalOpen(false)}
        templates={templates}
        onSelectTemplate={handleTemplateSelect}
      />
    </Form>
  );
}
