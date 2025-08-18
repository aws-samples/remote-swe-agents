'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { Controller } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ModelType, modelConfigs, modelTypeList } from '@remote-swe-agents/agent-core/schema';
import { createCustomAgent } from '../actions';
import { createCustomAgentSchema } from '../schemas';
import { Form, FormControl, FormField } from '@/components/ui/form';

export default function CustomAgentForm() {
  const t = useTranslations('customAgent');
  const [toolsInput, setToolsInput] = useState('');

  const {
    form,
    action: { isPending },
    handleSubmitWithAction,
  } = useHookFormAction(createCustomAgent, zodResolver(createCustomAgentSchema), {
    actionProps: {
      onSuccess: () => {
        toast.success(t('createSuccess'));
        // Reset form
        reset();
        setToolsInput('');
      },
      onError: ({ error }) => {
        const errorMessage = typeof error === 'string' ? error : t('createError');
        toast.error(errorMessage);
      },
    },
    formProps: {
      defaultValues: {
        name: '',
        defaultModel: 'sonnet3.7',
        systemPrompt: '',
        tools: [],
        mcpConfig: '',
      },
    },
  });
  const { register, formState, setValue, reset, control } = form;

  const handleToolsChange = (value: string) => {
    setToolsInput(value);
    const toolsArray = value
      .split(',')
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0);
    setValue('tools', toolsArray);
  };

  return (
    <Form {...form}>
      <form onSubmit={handleSubmitWithAction} className="space-y-6">
        {/* Agent Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('form.name.label')}
          </label>
          <Input
            {...register('name')}
            type="text"
            placeholder={t('form.name.placeholder')}
            disabled={isPending}
            className="w-full"
          />
          {formState.errors.name && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formState.errors.name.message}</p>
          )}
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.name.description')}</p>
        </div>

        {/* Default Model */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('form.defaultModel.label')}
          </label>
          <FormField
            name="defaultModel"
            control={control}
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} disabled={isPending}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('form.defaultModel.placeholder')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {modelTypeList
                    .filter((type) => !modelConfigs[type].isHidden)
                    .map((type) => (
                      <SelectItem key={type} value={type}>
                        {modelConfigs[type].name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          />
          {formState.errors.defaultModel && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formState.errors.defaultModel.message}</p>
          )}
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.defaultModel.description')}</p>
        </div>

        {/* System Prompt */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('form.systemPrompt.label')}
          </label>
          <textarea
            {...register('systemPrompt')}
            placeholder={t('form.systemPrompt.placeholder')}
            disabled={isPending}
            rows={6}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
          />
          {formState.errors.systemPrompt && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formState.errors.systemPrompt.message}</p>
          )}
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.systemPrompt.description')}</p>
        </div>

        {/* Tools */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('form.tools.label')}
          </label>
          <Input
            type="text"
            value={toolsInput}
            onChange={(e) => handleToolsChange(e.target.value)}
            placeholder={t('form.tools.placeholder')}
            disabled={isPending}
            className="w-full"
          />
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.tools.description')}</p>
        </div>

        {/* MCP Config */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('form.mcpConfig.label')}
          </label>
          <textarea
            {...register('mcpConfig')}
            placeholder={t('form.mcpConfig.placeholder')}
            disabled={isPending}
            rows={4}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
          />
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.mcpConfig.description')}</p>
        </div>

        {/* Submit Button */}
        <div className="flex justify-end">
          <Button type="submit" disabled={isPending || !formState.isValid} className="px-6 py-2">
            {isPending && (
              <div className="mr-2 animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-white"></div>
            )}
            {isPending ? t('form.creating') : t('form.create')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
