'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { useAction } from 'next-safe-action/hooks';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useState } from 'react';
import { ChevronDownIcon, WandIcon, TrashIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyMcpConfig, modelConfigs, modelTypeList } from '@remote-swe-agents/agent-core/schema';
import { upsertCustomAgentAction, deleteCustomAgentAction } from '../actions';
import { upsertCustomAgentSchema } from '../schemas';
import type { CustomAgent } from '@remote-swe-agents/agent-core/schema';
import { Form, FormControl, FormField } from '@/components/ui/form';
import { useRouter } from 'next/navigation';

type CustomAgentFormProps = {
  availableTools: { name: string; description: string }[];
  editingAgent?: CustomAgent;
  onSuccess?: () => void;
};

export default function CustomAgentForm({ availableTools, editingAgent, onSuccess }: CustomAgentFormProps) {
  const t = useTranslations('customAgent');
  const isEditing = Boolean(editingAgent);
  const router = useRouter();
  const [selectedTools, setSelectedTools] = useState<string[]>(editingAgent?.tools || []);
  const [useDefaultSystemPrompt, setUseDefaultSystemPrompt] = useState<boolean>(!editingAgent?.systemPrompt);

  const {
    form,
    action: { isPending },
    handleSubmitWithAction,
  } = useHookFormAction(upsertCustomAgentAction, zodResolver(upsertCustomAgentSchema), {
    actionProps: {
      onSuccess: () => {
        toast.success(isEditing ? t('updateSuccess') : t('createSuccess'));
        router.refresh();
        if (isEditing && onSuccess) {
          onSuccess();
        } else {
          // Reset form for create mode
          reset();
          setSelectedTools([]);
        }
      },
      onError: ({ error }) => {
        const errorMessage = typeof error === 'string' ? error : isEditing ? t('updateError') : t('createError');
        toast.error(errorMessage);
      },
    },
    formProps: {
      defaultValues: {
        id: editingAgent?.SK,
        name: editingAgent?.name ?? '',
        description: editingAgent?.description ?? '',
        defaultModel: editingAgent?.defaultModel ?? 'sonnet3.7',
        systemPrompt: editingAgent?.systemPrompt ?? '',
        tools: editingAgent?.tools ?? [],
        mcpConfig: editingAgent?.mcpConfig ?? JSON.stringify(EmptyMcpConfig, undefined, 2),
        runtimeType: editingAgent?.runtimeType ?? 'agent-core',
      },
    },
  });
  const { register, formState, setValue, reset, control } = form;

  const { execute: deleteAgent, isPending: isDeleting } = useAction(deleteCustomAgentAction, {
    onSuccess: () => {
      toast.success(t('deleteSuccess'));
      router.refresh();
      if (onSuccess) {
        onSuccess();
      }
    },
    onError: ({ error }) => {
      const errorMessage = typeof error === 'string' ? error : t('deleteError');
      toast.error(errorMessage);
    },
  });

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

  const formatJsonConfig = () => {
    const currentValue = form.getValues('mcpConfig');
    if (!currentValue?.trim()) return;

    try {
      const parsed = JSON.parse(currentValue);
      const formatted = JSON.stringify(parsed, null, 2);
      setValue('mcpConfig', formatted);
      toast.success(t('form.mcpConfig.formatSuccess'));
    } catch (error) {
      toast.error(t('form.mcpConfig.formatError'));
    }
  };

  const handleDelete = () => {
    if (!editingAgent?.SK) return;

    if (window.confirm(t('form.confirmDelete'))) {
      deleteAgent({ id: editingAgent.SK });
    }
  };

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (useDefaultSystemPrompt) {
      setValue('systemPrompt', '');
    }
    handleSubmitWithAction(e);
  };

  return (
    <Form {...form}>
      <form onSubmit={handleFormSubmit} className="space-y-6">
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
          <div className="flex items-center gap-2 mb-3">
            <Checkbox
              id="useDefaultSystemPrompt"
              checked={useDefaultSystemPrompt}
              onCheckedChange={(checked) => setUseDefaultSystemPrompt(checked === true)}
              disabled={isPending}
            />
            <label htmlFor="useDefaultSystemPrompt" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              {t('form.systemPrompt.useDefault')}
            </label>
          </div>
          {!useDefaultSystemPrompt && (
            <textarea
              {...register('systemPrompt')}
              placeholder={t('form.systemPrompt.placeholder')}
              disabled={isPending}
              rows={6}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
            />
          )}
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
                <span className={selectedTools.length === 0 ? 'font-normal text-muted-foreground' : ''}>
                  {selectedTools.length > 0
                    ? `${selectedTools.length} tool${selectedTools.length > 1 ? 's' : ''} selected`
                    : t('form.tools.placeholder')}
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
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('form.mcpConfig.label')}
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={formatJsonConfig}
              disabled={isPending}
              className="flex items-center gap-1 text-xs"
            >
              <WandIcon className="h-3 w-3" />
              {t('form.mcpConfig.formatJson')}
            </Button>
          </div>
          <textarea
            {...register('mcpConfig')}
            placeholder={t('form.mcpConfig.placeholder')}
            disabled={isPending}
            rows={4}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical font-mono text-sm"
          />
          {formState.errors.mcpConfig && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formState.errors.mcpConfig.message}</p>
          )}
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

        {/* Action Buttons */}
        <div className="flex justify-end gap-3">
          {isEditing && (
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting || isPending}
              className="px-6 py-2 flex items-center gap-2"
            >
              {isDeleting && (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-white"></div>
              )}
              {!isDeleting && <TrashIcon className="h-4 w-4" />}
              {isDeleting ? t('form.deleting') : t('form.delete')}
            </Button>
          )}

          <Button type="submit" disabled={isPending || !formState.isValid} className="px-6 py-2">
            {isPending && (
              <div className="mr-2 animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-white"></div>
            )}
            {isPending
              ? isEditing
                ? t('form.updating')
                : t('form.creating')
              : isEditing
                ? t('form.update')
                : t('form.create')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
