'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { Loader2, Send, Image as ImageIcon, Share } from 'lucide-react';
import { toast } from 'sonner';
import { sendMessageToAgent } from '../actions';
import { sendMessageToAgentSchema } from '../schemas';
import { KeyboardEventHandler, useCallback, useRef } from 'react';
import { MessageView } from './MessageList';
import { useTranslations } from 'next-intl';
import ImageUploader from '@/components/ImageUploader';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelType, getAvailableModelTypes, modelConfigs, modelTypeList } from '@remote-swe-agents/agent-core/schema';

type MessageFormProps = {
  onSubmit: (message: MessageView) => void;
  workerId: string;
  onShareSession: () => void;
  defaultModelOverride: ModelType;
};

export default function MessageForm({ onSubmit, workerId, onShareSession, defaultModelOverride }: MessageFormProps) {
  const t = useTranslations('sessions');

  const {
    form: { register, formState, reset, watch, setValue },
    action: { isExecuting },
    handleSubmitWithAction,
  } = useHookFormAction(sendMessageToAgent, zodResolver(sendMessageToAgentSchema), {
    actionProps: {
      onSuccess: (args) => {
        if (args.data) {
          onSubmit({
            id: args.data.item.SK,
            role: 'user',
            content: args.input.message,
            timestamp: new Date(parseInt(args.data.item.SK)),
            type: 'message',
            modelOverride: args.input.modelOverride,
          });
        }
        reset();
        setValue('modelOverride', args.input.modelOverride);
        clearImages();
      },
      onError: ({ error }) => {
        toast.error(typeof error === 'string' ? error : 'Failed to send the message');
      },
    },
    formProps: {
      defaultValues: {
        message: '',
        workerId: workerId,
        imageKeys: [],
        modelOverride: defaultModelOverride,
      },
    },
  });

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

    textarea.style.height = newHeightPx;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  const enterPost: KeyboardEventHandler = (keyEvent) => {
    if (isExecuting || isUploading) return;
    if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.altKey || keyEvent.metaKey)) {
      handleSubmitWithAction();
    }
  };

  const { uploadingImages, handleImageSelect, handlePaste, ImagePreviewList, clearImages } = ImageUploader({
    workerId,
    onImagesChange: (imageKeys) => {
      setValue('imageKeys', imageKeys);
    },
  });

  const isUploading = uploadingImages.some((img) => !img.key);

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="max-w-4xl mx-auto px-4 py-4">
        <form onSubmit={handleSubmitWithAction} className="flex flex-col gap-4">
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
                        onClick={handleImageSelect}
                        disabled={isExecuting}
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-600"
                      >
                        <ImageIcon className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('attachImage')}</p>
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
                <select
                  {...register('modelOverride')}
                  disabled={isExecuting}
                  className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 dark:text-white focus:outline-none"
                >
                  {getAvailableModelTypes()
                    .map((type) => (
                      <option key={type} value={type}>
                        {modelConfigs[type].name}
                      </option>
                    ))}
                </select>
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
        </form>
      </div>
    </div>
  );
}
