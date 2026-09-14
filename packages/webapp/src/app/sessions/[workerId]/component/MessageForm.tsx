'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { Loader2, Send, Paperclip, Share } from 'lucide-react';
import { toast } from 'sonner';
import { sendMessageToAgent, updateSessionModel } from '../actions';
import { sendMessageToAgentSchema } from '../schemas';
import { KeyboardEventHandler, useCallback, useEffect, useRef } from 'react';
import { MessageView } from './MessageList';
import { useTranslations } from 'next-intl';
import ImageUploader from '@/components/ImageUploader';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAction } from 'next-safe-action/hooks';
import {
  ModelType,
  InferenceMode,
  getAvailableModelTypes,
  modelConfigs,
  kiroModelConfigs,
  getKiroModelIds,
  KiroModelId,
} from '@remote-swe-agents/agent-core/schema';

type MessageFormProps = {
  onSubmit: (message: MessageView) => void;
  onConfirm: (pendingId: string, confirmedId: string) => void;
  onRollback: (pendingId: string) => void;
  workerId: string;
  onShareSession: () => void;
  defaultModelOverride: ModelType;
  /**
   * Display name of the currently signed-in user. When set, the optimistic
   * pending bubble the submitter sees carries
   * `userSenderDisplayName = currentUserDisplayName`, so their own message
   * is labelled with their name instead of the generic "User".
   */
  currentUserDisplayName?: string;
  /**
   * Stable Cognito user id of the currently signed-in user. Mirrors
   * `senderUserId` on the persisted message item so that the optimistic
   * bubble carries the same `userSenderUserId` as the server-rendered
   * variant — important for `MessageList` grouping (see
   * `getMessageSenderKey`).
   */
  currentUserId?: string;
  /**
   * Effective inference mode for this session. When `'kiro-cli'` the Bedrock
   * model selector is replaced with a Kiro model selector that lets the user
   * swap the model per message via the `/model` slash command in kiro-cli.
   */
  inferenceMode?: InferenceMode;
  /**
   * Default Kiro model for this session, resolved server-side as
   * `session.kiroModel > userPrefs.kiroModel > 'auto'`. Used as the initial
   * value of the per-message selector on Kiro sessions.
   */
  kiroModel?: string;
};

export default function MessageForm({
  onSubmit,
  onConfirm,
  onRollback,
  workerId,
  onShareSession,
  defaultModelOverride,
  currentUserDisplayName,
  currentUserId,
  inferenceMode,
  kiroModel,
}: MessageFormProps) {
  const t = useTranslations('sessions');
  const draftStorageKey = `draft-message-${workerId}`;

  const isKiroSession = inferenceMode === 'kiro-cli';
  const kiroModelIds = getKiroModelIds();
  const defaultKiroModel = kiroModel && kiroModel in kiroModelConfigs ? kiroModel : 'auto';

  // Session-level model sync: selector changes are debounced and persisted on
  // the session item so they survive page reloads and apply to future turns.
  const { execute: executeUpdateModel } = useAction(updateSessionModel, {
    onError: () => {
      toast.error(t('modelUpdateFailed'));
    },
  });
  const modelUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingModelChangeRef = useRef<{ field: 'bedrock' | 'kiro'; value: string } | null>(null);

  const flushModelChange = useCallback(() => {
    if (modelUpdateTimeoutRef.current) {
      clearTimeout(modelUpdateTimeoutRef.current);
      modelUpdateTimeoutRef.current = null;
    }
    const pending = pendingModelChangeRef.current;
    if (pending) {
      pendingModelChangeRef.current = null;
      if (pending.field === 'bedrock') {
        executeUpdateModel({ workerId, bedrockDefaultModel: pending.value as ModelType });
      } else {
        executeUpdateModel({ workerId, kiroDefaultModel: pending.value as KiroModelId });
      }
    }
  }, [workerId, executeUpdateModel]);

  useEffect(() => {
    return () => {
      flushModelChange();
    };
  }, [flushModelChange]);

  const handleModelChange = useCallback(
    (field: 'bedrock' | 'kiro', value: string) => {
      pendingModelChangeRef.current = { field, value };
      if (modelUpdateTimeoutRef.current) {
        clearTimeout(modelUpdateTimeoutRef.current);
      }
      modelUpdateTimeoutRef.current = setTimeout(() => {
        modelUpdateTimeoutRef.current = null;
        pendingModelChangeRef.current = null;
        if (field === 'bedrock') {
          executeUpdateModel({ workerId, bedrockDefaultModel: value as ModelType });
        } else {
          executeUpdateModel({ workerId, kiroDefaultModel: value as KiroModelId });
        }
      }, 300);
    },
    [workerId, executeUpdateModel]
  );

  const pendingRef = useRef<{ id: string; message: string; modelOverride?: ModelType } | null>(null);

  const {
    form: { register, formState, reset, watch, setValue, getValues },
    action: { isExecuting },
    handleSubmitWithAction,
  } = useHookFormAction(sendMessageToAgent, zodResolver(sendMessageToAgentSchema), {
    actionProps: {
      onSuccess: (args) => {
        if (args.data && pendingRef.current) {
          onConfirm(pendingRef.current.id, args.data.item.SK);
        }
        pendingRef.current = null;
        reset();
        setValue('modelOverride', args.input.modelOverride);
        setValue('kiroModelOverride', args.input.kiroModelOverride);
        clearImagesRef.current();
        try {
          localStorage.removeItem(draftStorageKey);
        } catch {}
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          textareaRef.current.style.overflowY = 'hidden';
        }
      },
      onError: ({ error }) => {
        if (pendingRef.current) {
          onRollback(pendingRef.current.id);
          setValue('message', pendingRef.current.message);
          if (pendingRef.current.modelOverride) {
            setValue('modelOverride', pendingRef.current.modelOverride);
          }
          pendingRef.current = null;
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              textareaRef.current.style.height = 'auto';
              const maxHeight = 600;
              const scrollHeight = textareaRef.current.scrollHeight;
              const newHeight = Math.min(scrollHeight, maxHeight);
              textareaRef.current.style.height = `${newHeight}px`;
              textareaRef.current.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
            }
          });
        }
        toast.error(typeof error === 'string' ? error : 'Failed to send the message');
      },
    },
    formProps: {
      defaultValues: {
        message: '',
        workerId: workerId,
        imageKeys: [],
        fileKeys: [],
        modelOverride: defaultModelOverride,
        kiroModelOverride: defaultKiroModel,
      },
    },
  });

  const clearImagesRef = useRef<() => void>(() => {});

  // Restore draft message from localStorage on mount
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    try {
      const savedDraft = localStorage.getItem(draftStorageKey);
      if (savedDraft) {
        setValue('message', savedDraft);
        // Restore textarea height after setting value
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            const maxHeight = 600;
            const scrollHeight = textareaRef.current.scrollHeight;
            const newHeight = Math.min(scrollHeight, maxHeight);
            textareaRef.current.style.height = `${newHeight}px`;
            textareaRef.current.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
          }
        });
      }
    } catch {}
  }, [draftStorageKey, setValue]);

  // Save draft message to localStorage on change
  const messageValue = watch('message');
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      try {
        if (messageValue) {
          localStorage.setItem(draftStorageKey, messageValue);
        } else {
          localStorage.removeItem(draftStorageKey);
        }
      } catch {}
    }, 300);
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [messageValue, draftStorageKey]);

  const { ref: messageRef, ...messageRegister } = register('message');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const currentHeight = textarea.style.height;
    textarea.style.height = 'auto';
    const maxHeight = 600;
    const scrollHeight = textarea.scrollHeight;
    const newHeight = Math.min(scrollHeight, maxHeight);
    const newHeightPx = `${newHeight}px`;

    // skip updating the height when it is not changed.
    if (currentHeight === newHeightPx) {
      textarea.style.height = currentHeight;
      return;
    }

    // Save current scroll position and calculate height difference
    const scrollBefore = window.scrollY;
    const oldHeight = parseFloat(currentHeight) || textarea.offsetHeight;
    const heightDiff = newHeight - oldHeight;

    textarea.style.height = newHeightPx;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';

    // Compensate for the height change to prevent page from scrolling down
    if (heightDiff !== 0) {
      window.scrollTo({ top: scrollBefore + heightDiff, behavior: 'instant' });
    }
  }, []);

  const enterPost: KeyboardEventHandler = (keyEvent) => {
    if (isExecuting || isUploading) return;
    if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.altKey || keyEvent.metaKey)) {
      handleOptimisticSubmit();
    }
  };

  const {
    uploadingImages,
    uploadingFiles,
    handleFileSelect,
    handlePaste,
    ImagePreviewList,
    clearImages,
    isUploading: isUploadingFiles,
  } = ImageUploader({
    workerId,
    onImagesChange: (imageKeys) => {
      setValue('imageKeys', imageKeys);
    },
    onFilesChange: (fileKeys) => {
      setValue('fileKeys', fileKeys);
    },
  });

  clearImagesRef.current = clearImages;

  const isUploading = isUploadingFiles;

  const handleOptimisticSubmit = useCallback(
    (e?: React.BaseSyntheticEvent) => {
      flushModelChange();
      const message = getValues('message');
      const modelOverride = getValues('modelOverride');
      if (message?.trim()) {
        // Per-submission identity for the realtime echo dedup: the id is
        // stamped on the optimistic bubble AND shipped with the server
        // action, which forwards it verbatim on the rebroadcast event.
        // When that rebroadcast lands on this tab, `dedup.ts` matches by
        // id and merges the event's attachment keys onto the existing
        // bubble instead of rendering a duplicate.
        //
        // `crypto.randomUUID()` is supported in all evergreen browsers and
        // in Next.js's secure contexts. If it is somehow unavailable
        // (e.g. legacy headless test environment), we fall back to a
        // collision-resistant `pending-` + Date.now() string — that path
        // loses dedup but never crashes the submit.
        const clientId =
          typeof globalThis.crypto?.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setValue('clientId', clientId);
        const pendingId = `pending-${Date.now()}`;
        pendingRef.current = { id: pendingId, message, modelOverride };
        onSubmit({
          id: pendingId,
          role: 'user',
          content: message,
          timestamp: new Date(),
          type: 'message',
          modelOverride,
          pending: true,
          clientId,
          // Label the optimistic bubble with the submitter's own display
          // name so they see "<displayName>" instead of the generic
          // "User" while the server action is in flight.
          ...(currentUserDisplayName ? { userSenderDisplayName: currentUserDisplayName } : {}),
          ...(currentUserId ? { userSenderUserId: currentUserId } : {}),
          userSenderType: 'webapp',
        });
      }
      handleSubmitWithAction(e);
      setValue('message', '');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.overflowY = 'hidden';
      }
    },
    [getValues, onSubmit, handleSubmitWithAction, setValue, currentUserDisplayName, currentUserId]
  );

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="max-w-4xl mx-auto px-4 py-4">
        <form onSubmit={handleOptimisticSubmit} className="flex flex-col gap-4">
          <ImagePreviewList />

          <div className="border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus-within:border-gray-400 dark:focus-within:border-gray-500">
            <textarea
              // https://qiita.com/P-man_Brown/items/63fc7d281baae22c74e5
              {...messageRegister}
              ref={(e) => {
                messageRef(e);
                textareaRef.current = e;
              }}
              placeholder={isUploading ? t('waitingForImageUpload') : t('enterYourMessage')}
              className="w-full resize-none border-0 bg-transparent text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 px-4 pt-3 pb-3 focus:outline-none focus:ring-0 min-h-[2rem] overflow-hidden"
              disabled={isExecuting || isUploading}
              onKeyDown={enterPost}
              onPaste={handlePaste}
              onInput={autoResize}
            />

            <div className="flex items-center justify-between px-2 pb-2">
              <div className="flex gap-1">
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        onClick={handleFileSelect}
                        disabled={isExecuting}
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-600"
                      >
                        <Paperclip className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('attachFile')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        onClick={onShareSession}
                        disabled={isExecuting}
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-600"
                      >
                        <Share className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('shareSession')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>

              <div className="flex gap-2 items-center">
                {isKiroSession ? (
                  <select
                    {...register('kiroModelOverride', {
                      onChange: (e) => handleModelChange('kiro', e.target.value),
                    })}
                    disabled={isExecuting}
                    aria-label={t('kiroModelSelector')}
                    className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 dark:text-white focus:outline-none"
                  >
                    {kiroModelIds.map((id) => (
                      <option key={id} value={id}>
                        {kiroModelConfigs[id]?.name ?? id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    {...register('modelOverride', {
                      onChange: (e) => handleModelChange('bedrock', e.target.value),
                    })}
                    disabled={isExecuting}
                    className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 dark:text-white focus:outline-none"
                  >
                    {getAvailableModelTypes().map((type) => (
                      <option key={type} value={type}>
                        {modelConfigs[type].name}
                      </option>
                    ))}
                  </select>
                )}
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="submit"
                        disabled={!formState.isValid || isExecuting || isUploading}
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                      >
                        {isExecuting ? (
                          <Loader2 className="w-6 h-6 animate-spin" strokeWidth={2.5} />
                        ) : isUploading ? (
                          <Loader2 className="w-6 h-6 animate-spin" strokeWidth={2.5} />
                        ) : (
                          <Send className="w-6 h-6" strokeWidth={2.5} />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('sendWithCtrlEnter')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          </div>

          <input hidden {...register('workerId')} />
          <input hidden {...register('imageKeys')} />
          <input hidden {...register('fileKeys')} />
        </form>
      </div>
    </div>
  );
}
