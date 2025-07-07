'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { Loader2, Send, Image as ImageIcon, Paperclip, Smile, AtSign, Hash, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { sendMessageToAgent } from '../actions';
import { sendMessageToAgentSchema } from '../schemas';
import { KeyboardEventHandler, useEffect, useRef } from 'react';
import { MessageView } from './MessageList';
import { useTranslations } from 'next-intl';
import ImageUploader from '@/components/ImageUploader';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

type MessageFormProps = {
  onSubmit: (message: MessageView) => void;
  workerId: string;
};

export default function MessageForm({ onSubmit, workerId }: MessageFormProps) {
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
          });
        }
        reset();
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
      },
    },
  });

  const message = watch('message');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const maxHeight = 200; // max height in pixels
      const newHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${newHeight}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }
  };

  useEffect(() => {
    autoResize();
  }, [message]);

  const enterPost: KeyboardEventHandler = (keyEvent) => {
    if (isExecuting || isUploading) return;
    if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.altKey || keyEvent.metaKey)) {
      handleSubmitWithAction();
    }
  };

  const { uploadingImages, fileInputRef, handleImageSelect, handlePaste, ImagePreviewList } = ImageUploader({
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

          <textarea
            {...register('message')}
            ref={textareaRef}
            placeholder={isUploading ? t('waitingForImageUpload') : t('enterYourMessage')}
            className="w-full resize-none border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent mb-2 min-h-[3rem] overflow-hidden"
            disabled={isExecuting || isUploading}
            onKeyDown={enterPost}
            onPaste={handlePaste}
            onInput={autoResize}
          />

          <div className="flex justify-between items-center">
            <div className="flex gap-2">
              <TooltipProvider delayDuration={100}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" onClick={handleImageSelect} disabled={isExecuting} size="icon" variant="ghost">
                      <ImageIcon className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t('attachImage')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Button type="button" disabled={isExecuting} size="icon" variant="ghost">
                <Paperclip className="w-4 h-4" />
              </Button>
              <Button type="button" disabled={isExecuting} size="icon" variant="ghost">
                <Smile className="w-4 h-4" />
              </Button>
              <Button type="button" disabled={isExecuting} size="icon" variant="ghost">
                <AtSign className="w-4 h-4" />
              </Button>
              <Button type="button" disabled={isExecuting} size="icon" variant="ghost">
                <Hash className="w-4 h-4" />
              </Button>
              <Button type="button" disabled={isExecuting} size="icon" variant="ghost">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="submit" disabled={!message.trim() || isExecuting || isUploading} size="icon">
                    {isExecuting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : isUploading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('sendWithCtrlEnter')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          <input hidden {...register('workerId')} />
          <input hidden {...register('imageKeys')} />
        </form>
      </div>
    </div>
  );
}
