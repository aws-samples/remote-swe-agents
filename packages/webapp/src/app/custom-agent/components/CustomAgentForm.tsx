'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useState } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { modelConfigs, modelTypeList } from '@remote-swe-agents/agent-core/schema';
import { createCustomAgent } from '../actions';
import { createCustomAgentSchema } from '../schemas';
import { Form, FormControl, FormField } from '@/components/ui/form';

type CustomAgentFormProps = {
  availableTools: { name: string; description: string }[];
};

export default function CustomAgentForm({ availableTools }: CustomAgentFormProps) {
  const t = useTranslations('customAgent');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

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
        setSelectedTools([]);
      },
      onError: ({ error }) => {
        const errorMessage = typeof error === 'string' ? error : t('createError');
        toast.error(errorMessage);
      },
    },
    formProps: {
      defaultValues: {
        name: '',
        description: '',
        defaultModel: 'sonnet3.7',
        systemPrompt: '',
        tools: [],
        mcpConfig: '',
        runtimeType: 'agent-core',
      },
    },
  });
  const { register, formState, setValue, reset, control } = form;

  const handleToolToggle = (toolName: string, checked: boolean) => {
    let newSelectedTools: string[];
    if (checked) {
      newSelectedTools = [...selectedTools, toolName];
    } else {
      newSelectedTools = selectedTools.filter((tool) => tool !== toolName);
    }
    setSelectedTools(newSelectedTools);
    setValue('tools', newSelectedTools);
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

        {/* Agent Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('form.description.label')}
          </label>
          <textarea
            {...register('description')}
            placeholder={t('form.description.placeholder')}
            disabled={isPending}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
          />
          {formState.errors.description && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formState.errors.description.message}</p>
          )}
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.description.description')}</p>
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full justify-between" disabled={isPending}>
                <span className={selectedTools.length === 0 ? "font-normal text-muted-foreground" : ""}>
                  {selectedTools.length > 0 
                    ? `${selectedTools.length} tool${selectedTools.length > 1 ? 's' : ''} selected`
                    : t('form.tools.placeholder')
                  }
                </span>
                <ChevronDownIcon className="h-4 w-4 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-full min-w-[400px]" align="start">
              <DropdownMenuLabel>Available Tools</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <TooltipProvider>
                {availableTools.map((tool) => (
                  <DropdownMenuCheckboxItem
                    key={tool.name}
                    checked={selectedTools.includes(tool.name)}
                    onCheckedChange={(checked) => handleToolToggle(tool.name, checked)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">{tool.name}</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-sm text-gray-500 cursor-help max-w-lg overflow-hidden text-ellipsis whitespace-nowrap block">
                            {tool.description}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-md">
                          <p className="whitespace-pre-wrap break-words">{tool.description}</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </DropdownMenuCheckboxItem>
                ))}
              </TooltipProvider>
            </DropdownMenuContent>
          </DropdownMenu>
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

        {/* Runtime Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('form.runtimeType.label')}
          </label>
          <FormField
            name="runtimeType"
            control={control}
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} disabled={isPending}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('form.runtimeType.placeholder')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="agent-core">AgentCore Runtime</SelectItem>
                  <SelectItem value="ec2">EC2</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          {formState.errors.runtimeType && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formState.errors.runtimeType.message}</p>
          )}
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.runtimeType.description')}</p>
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
