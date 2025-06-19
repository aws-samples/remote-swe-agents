'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Image as ImageIcon, FileText } from 'lucide-react';
import { createNewWorker } from './actions';
import { createNewWorkerSchema, PromptTemplate } from './schemas';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import ImageUploader from '@/components/ImageUploader';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useState } from 'react';
import TemplateModal from './TemplateModal';

interface NewSessionFormProps {
  templates: PromptTemplate[];
}

export default function NewSessionForm({ templates }: NewSessionFormProps) {
  const router = useRouter();
  const t = useTranslations('new_session');
  const sessionsT = useTranslations('sessions');
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);

  const {
    form: { register, formState, reset, setValue, watch },
    action: { isExecuting },
    handleSubmitWithAction,
  } = useHookFormAction(createNewWorker, zodResolver(createNewWorkerSchema), {
    actionProps: {
      onSuccess: (args) => {
        if (args.data) {
          router.push(`/sessions/${args.data.workerId}`);
        }
      },
      onError: ({ error }) => {
        toast.error(typeof error === 'string' ? error : 'Failed to create session');
      },
    },
    formProps: {
      defaultValues: {
        message: '',
        imageKeys: [],
      },
    },
  });

  const { uploadingImages, fileInputRef, handleImageSelect, handleImageChange, handlePaste, ImagePreviewList } =
    ImageUploader({
      onImagesChange: (keys) => {
        setValue('imageKeys', keys);
      },
    });

  const isUploading = uploadingImages.some((img) => !img.key);

  const handleTemplateSelect = (template: PromptTemplate) => {
    setValue('message', template.content);
    setIsTemplateModalOpen(false);
  };

  return (
    <>
      <form onSubmit={handleSubmitWithAction} className="space-y-6">
        <div className="text-left">
          <ImagePreviewList />

          <div className="flex items-center justify-between mb-2">
            <label htmlFor="message" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('initialMessage')}
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => setIsTemplateModalOpen(true)}
                disabled={isExecuting}
                size="sm"
                variant="outline"
                className="flex gap-2 items-center"
              >
                <FileText className="w-4 h-4" />
                {t('templates')}
              </Button>
              <Button
                type="button"
                onClick={handleImageSelect}
                disabled={isExecuting}
                size="sm"
                variant="outline"
                className="flex gap-2 items-center"
              >
                <ImageIcon className="w-4 h-4" />
                {uploadingImages.length > 0 ? t('imagesCount', { count: uploadingImages.length }) : t('addImage')}
              </Button>
            </div>
          </div>

          <textarea
            id="message"
            {...register('message')}
            placeholder={t('placeholder')}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
            rows={4}
            disabled={isExecuting}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                (e.ctrlKey || e.altKey || e.metaKey) &&
                !isExecuting &&
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
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="submit"
                disabled={isExecuting || !formState.isValid || isUploading}
                className="w-full"
                size="lg"
              >
                {isExecuting
                  ? t('creatingSession')
                  : isUploading
                    ? t('waitingForImageUpload')
                    : t('createSessionButton')}
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
    </>
  );
}
