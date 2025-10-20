'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { Button } from '@/components/ui/button';
import { Image as ImageIcon, FileText } from 'lucide-react';
import { createNewWorker } from './actions';
import { createNewWorkerSchema, PromptTemplate } from './schemas';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import ImageUploader from '@/components/ImageUploader';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField } from '@/components/ui/form';
import { useState } from 'react';
import TemplateModal from './TemplateModal';
import {
  CustomAgent,
  getAvailableModelTypes,
  GlobalPreferences,
  modelConfigs,
} from '@remote-swe-agents/agent-core/schema';

interface NewSessionFormProps {
  templates: PromptTemplate[];
  customAgents: CustomAgent[];
  preferences: GlobalPreferences;
}

export default function NewSessionForm({ templates, customAgents, preferences }: NewSessionFormProps) {
  const t = useTranslations('new_session');
  const sessionsT = useTranslations('sessions');
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);

  const {
    form,
    action: { isPending },
    handleSubmitWithAction,
  } = useHookFormAction(createNewWorker, zodResolver(createNewWorkerSchema), {
    actionProps: {
      onSuccess: (args) => {},
      onError: ({ error }) => {
        toast.error(typeof error === 'string' ? error : 'Failed to create session');
      },
    },
    formProps: {
      defaultValues: {
        message: '',
        imageKeys: [],
        modelOverride: preferences.modelOverride,
        customAgentId: 'DEFAULT',
      },
    },
  });
  const { register, formState, reset, setValue, watch, control } = form;

  const { uploadingImages, fileInputRef, handleImageSelect, handleImageChange, handlePaste, ImagePreviewList } =
    ImageUploader({
      onImagesChange: (keys) => {
        setValue('imageKeys', keys);
      },
    });

  const isUploading = uploadingImages.some((img) => !img.key);

  const handleTemplateSelect = (template: PromptTemplate) => {
    setValue('message', template.content, { shouldValidate: true });
    setIsTemplateModalOpen(false);
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
                      setValue('modelOverride', agent.defaultModel);
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
                        <div className="flex flex-col">
                          <span className="font-medium">{agent.name}</span>
                          <span className="text-sm text-gray-500">{agent.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {/* Model Override Selection */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('modelOverride')}
            </label>
            <FormField
              name="modelOverride"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={isPending}>
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
                onClick={handleImageSelect}
                disabled={isPending}
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
