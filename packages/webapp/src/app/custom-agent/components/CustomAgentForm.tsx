'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { useAction } from 'next-safe-action/hooks';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useState, useEffect, ReactNode } from 'react';
import { CheckIcon, ChevronDownIcon, PlusIcon, WandIcon, TrashIcon, XIcon } from 'lucide-react';
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
import {
  EmptyMcpConfig,
  getAvailableModelTypes,
  modelConfigs,
  kiroModelConfigs,
  getKiroModelIds,
  mcpConfigSchema,
} from '@remote-swe-agents/agent-core/schema';
import { upsertCustomAgentAction, deleteCustomAgentAction } from '../actions';
import { upsertCustomAgentSchema } from '../schemas';
import type { CustomAgent, InferenceMode, ModelType, KiroModelId } from '@remote-swe-agents/agent-core/schema';
import { Form, FormControl, FormField } from '@/components/ui/form';
import { useRouter } from 'next/navigation';
import AgentIconPicker from './AgentIconPicker';
import { runDeleteSuccessNavigation } from './delete-navigation';

type McpServerRow = {
  name: string;
  command: string;
  args: string;
};

const parseMcpRows = (mcpConfig: string | undefined): McpServerRow[] | undefined => {
  if (!mcpConfig?.trim()) return [];
  try {
    const parsed = mcpConfigSchema.parse(JSON.parse(mcpConfig));
    const rows: McpServerRow[] = [];
    for (const [name, server] of Object.entries(parsed.mcpServers)) {
      if ('url' in server || ('env' in server && server.env) || ('enabled' in server && server.enabled !== undefined)) {
        return undefined;
      }
      if ('command' in server) {
        rows.push({ name, command: server.command, args: server.args.join(', ') });
      }
    }
    return rows;
  } catch {
    return undefined;
  }
};

const rowsToMcpConfig = (rows: McpServerRow[]): string => {
  if (rows.length === 0) return JSON.stringify(EmptyMcpConfig, undefined, 2);
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  rows.forEach((row, i) => {
    mcpServers[row.name || `server-${i + 1}`] = {
      command: row.command,
      args: row.args
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a.length > 0),
    };
  });
  return JSON.stringify({ mcpServers }, undefined, 2);
};

type CustomAgentFormProps = {
  availableTools: { name: string; description: string }[];
  editingAgent?: CustomAgent;
  childAgents?: CustomAgent[];
  onSuccess?: () => void;
  // Called instead of the default refresh + onSuccess when a delete succeeds.
  // Required when the form edits the agent that owns the current page (e.g. the
  // detail page), because refreshing a deleted agent's force-dynamic route
  // triggers notFound() -> 404. The caller is responsible for navigating away.
  onDeleted?: () => void;
};

function FormSection({
  step,
  title,
  description,
  defaultOpen,
  children,
}: {
  step: string;
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex justify-between items-center p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors rounded-lg"
      >
        <span>
          <span className="text-base font-semibold block">
            {step}. {title}
          </span>
          <span className="text-sm text-gray-500 dark:text-gray-400">{description}</span>
        </span>
        <ChevronDownIcon
          className={`h-4 w-4 text-gray-500 transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div className={`px-4 pb-4 space-y-6 ${open ? '' : 'hidden'}`}>{children}</div>
    </div>
  );
}

export default function CustomAgentForm({
  availableTools,
  editingAgent,
  childAgents,
  onSuccess,
  onDeleted,
}: CustomAgentFormProps) {
  const t = useTranslations('customAgent');
  const isEditing = Boolean(editingAgent);
  const router = useRouter();
  const [selectedTools, setSelectedTools] = useState<string[]>(editingAgent?.tools || []);
  const [useAllTools, setUseAllTools] = useState<boolean>(editingAgent?.useAllTools ?? false);
  const [includeDefaultKnowledge, setIncludeDefaultKnowledge] = useState<boolean>(
    editingAgent?.includeDefaultKnowledge !== false
  );
  const initialMcpRows = parseMcpRows(editingAgent?.mcpConfig);
  const [mcpRows, setMcpRows] = useState<McpServerRow[]>(initialMcpRows ?? []);
  const [mcpAdvanced, setMcpAdvanced] = useState<boolean>(initialMcpRows === undefined);

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
          setMcpRows([]);
          setMcpAdvanced(false);
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
        defaultModel: editingAgent?.bedrockDefaultModel ?? editingAgent?.defaultModel ?? 'sonnet3.7',
        bedrockDefaultModel: editingAgent?.bedrockDefaultModel ?? editingAgent?.defaultModel ?? 'sonnet3.7',
        kiroDefaultModel:
          editingAgent?.kiroDefaultModel ??
          (editingAgent?.kiroModel && editingAgent.kiroModel in kiroModelConfigs
            ? (editingAgent.kiroModel as KiroModelId)
            : 'auto'),
        systemPrompt: editingAgent?.systemPrompt ?? '',
        tools: editingAgent?.tools ?? [],
        useAllTools: editingAgent?.useAllTools ?? false,
        mcpConfig: editingAgent?.mcpConfig ?? JSON.stringify(EmptyMcpConfig, undefined, 2),
        runtimeType: editingAgent?.runtimeType ?? 'agent-core',
        iconKey: editingAgent?.iconKey ?? '',
        includeDefaultKnowledge: editingAgent?.includeDefaultKnowledge !== false,
        inferenceMode: editingAgent?.inferenceMode ?? null,
        kiroModel: editingAgent?.kiroDefaultModel ?? editingAgent?.kiroModel ?? 'auto',
        parentAgentId: editingAgent?.parentAgentId,
      },
    },
  });
  const { register, formState, setValue, reset, control, watch } = form;
  const selectedInferenceMode = watch('inferenceMode');
  const currentIconKey = watch('iconKey');

  useEffect(() => {
    if (selectedInferenceMode === 'kiro-cli') {
      const currentKiroModel = form.getValues('kiroModel');
      if (!currentKiroModel) {
        setValue('kiroModel', 'auto');
        setValue('kiroDefaultModel', 'auto' as KiroModelId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInferenceMode]);

  const { executeAsync: deleteAgent, isPending: isDeleting } = useAction(deleteCustomAgentAction);

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

  const applyMcpRows = (rows: McpServerRow[]) => {
    setMcpRows(rows);
    setValue('mcpConfig', rowsToMcpConfig(rows), { shouldValidate: true });
  };

  const handleMcpAdvancedToggle = (advanced: boolean) => {
    if (advanced) {
      setMcpAdvanced(true);
    } else {
      const rows = parseMcpRows(form.getValues('mcpConfig'));
      if (rows === undefined) {
        toast.error(t('form.mcpConfig.structuredUnavailable'));
        return;
      }
      setMcpRows(rows);
      setMcpAdvanced(false);
    }
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

  const handleDelete = async () => {
    if (!editingAgent?.SK) return;

    const message =
      childAgents && childAgents.length > 0
        ? t('form.confirmDeleteWithChildren', {
            count: childAgents.length,
            names: childAgents.map((c) => c.name).join(', '),
          })
        : t('form.confirmDelete');
    if (!window.confirm(message)) return;

    // Run the delete via executeAsync and drive the success feedback from the
    // awaited continuation (a closure), NOT from useAction's onSuccess/onError.
    // next-safe-action fires those callbacks from a useLayoutEffect; on the
    // sub-agent path the server action's revalidatePath('/custom-agent')
    // re-renders the parent detail page and unmounts this collapsing row before
    // that layout effect runs, so the callback (and its toast) is dropped. The
    // awaited continuation is unaffected by unmount, so the toast always fires.
    //
    // When the form owns the current route (detail page, onDeleted set), we ask
    // the server to redirect to the list, avoiding the revalidate/notFound 404
    // race. redirect() surfaces as a navigation error that executeAsync neither
    // resolves nor rejects, so the continuation below simply does not run and
    // the list page shows the toast via ?deleted=1.
    // executeAsync rejects on thrown (non-navigation) errors, e.g. a network
    // failure. Catch it so the user still gets error feedback, matching the old
    // onError toast. The serverError branch below also uses t('deleteError'):
    // handleServerError masks the real message to an English default and the
    // old `typeof error === 'string'` check was always false for the object
    // error, so the old code effectively always showed the localized string.
    let result;
    try {
      result = await deleteAgent({ id: editingAgent.SK, redirectToListOnSuccess: Boolean(onDeleted) });
    } catch {
      toast.error(t('deleteError'));
      return;
    }
    if (result?.data) {
      toast.success(t('deleteSuccess'));
      runDeleteSuccessNavigation(router, { onDeleted, onSuccess });
    } else {
      toast.error(t('deleteError'));
    }
  };

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    handleSubmitWithAction(e);
  };

  const handleInferenceTabChange = (mode: InferenceMode | null) => {
    setValue('inferenceMode', mode, { shouldValidate: true });
  };

  const inferenceTabs: { mode: InferenceMode | null; label: string }[] = [
    { mode: null, label: t('form.inferenceMode.inherit') },
    { mode: 'bedrock', label: t('form.inferenceMode.bedrock') },
    { mode: 'kiro-cli', label: t('form.inferenceMode.kiro') },
  ];

  const duplicateMcpNames = Object.entries(
    mcpRows.reduce<Record<string, number>>((acc, row) => {
      const name = row.name.trim();
      if (name) acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {})
  )
    .filter(([, count]) => count > 1)
    .map(([name]) => name);

  return (
    <Form {...form}>
      <form onSubmit={handleFormSubmit} className="space-y-4">
        <FormSection
          step="1"
          title={t('form.sections.basic.title')}
          description={t('form.sections.basic.description')}
          defaultOpen
        >
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

          {/* Agent Icon */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('form.icon.label')}
            </label>
            <AgentIconPicker
              currentIconKey={currentIconKey || undefined}
              onIconKeyChange={(key) => setValue('iconKey', key)}
              disabled={isPending}
            />
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.icon.description')}</p>
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
        </FormSection>

        <FormSection
          step="2"
          title={t('form.sections.model.title')}
          description={t('form.sections.model.description')}
          defaultOpen={!isEditing}
        >
          {/* Unified Inference Mode tabs: selected tab = inferenceMode */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('form.inferenceMode.label')}
            </label>
            <div
              role="radiogroup"
              className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-100 dark:bg-gray-800 flex-wrap gap-1"
            >
              {inferenceTabs.map((tab) => {
                const isActive = selectedInferenceMode === tab.mode;
                return (
                  <button
                    key={tab.mode ?? 'inherit'}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    disabled={isPending}
                    onClick={() => handleInferenceTabChange(tab.mode)}
                    className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                      isActive
                        ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm ring-1 ring-blue-500'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                    } ${isPending && !isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {isActive && <CheckIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />}
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.inferenceMode.tabDescription')}</p>

            <div className="mt-3 border border-gray-200 dark:border-gray-700 rounded-md p-4">
              {selectedInferenceMode == null && (
                <p className="text-sm text-gray-600 dark:text-gray-400">{t('form.inferenceMode.inheritDescription')}</p>
              )}
              {selectedInferenceMode === 'bedrock' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('form.bedrockModel.label')}
                  </label>
                  <FormField
                    name="defaultModel"
                    control={control}
                    render={({ field }) => (
                      <Select
                        value={field.value}
                        onValueChange={(val) => {
                          field.onChange(val);
                          setValue('bedrockDefaultModel', val as ModelType);
                        }}
                        disabled={isPending}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t('form.bedrockModel.placeholder')} />
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
                  {formState.errors.defaultModel && (
                    <p className="mt-1 text-sm text-red-600 dark:text-red-400">
                      {formState.errors.defaultModel.message}
                    </p>
                  )}
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.bedrockModel.description')}</p>
                </div>
              )}
              {selectedInferenceMode === 'kiro-cli' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('form.kiroModel.label')}
                  </label>
                  <FormField
                    name="kiroModel"
                    control={control}
                    render={({ field }) => (
                      <Select
                        value={field.value ?? 'auto'}
                        onValueChange={(val) => {
                          field.onChange(val);
                          setValue('kiroDefaultModel', val as KiroModelId);
                        }}
                        disabled={isPending}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={t('form.kiroModel.placeholder')} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {getKiroModelIds().map((model) => (
                            <SelectItem key={model} value={model}>
                              {kiroModelConfigs[model].name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.kiroModel.description')}</p>
                </div>
              )}
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.inferenceMode.retentionNote')}</p>
          </div>
        </FormSection>

        <FormSection
          step="3"
          title={t('form.sections.behavior.title')}
          description={t('form.sections.behavior.description')}
        >
          {/* System Prompt */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('form.systemPrompt.label')}
            </label>
            <div className="flex items-center gap-2 mb-3">
              <Checkbox
                id="includeDefaultKnowledge"
                checked={includeDefaultKnowledge}
                onCheckedChange={(checked) => {
                  const val = checked === true;
                  setIncludeDefaultKnowledge(val);
                  setValue('includeDefaultKnowledge', val);
                }}
                disabled={isPending}
              />
              <label
                htmlFor="includeDefaultKnowledge"
                className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer"
              >
                {t('form.systemPrompt.includeDefaultKnowledge')}
              </label>
            </div>
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
        </FormSection>

        <FormSection
          step="4"
          title={t('form.sections.capabilities.title')}
          description={t('form.sections.capabilities.description')}
        >
          {/* Tools */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('form.tools.label')}
            </label>
            <div className="flex items-center gap-2 mb-3">
              <Checkbox
                id="useAllTools"
                checked={useAllTools}
                onCheckedChange={(checked) => {
                  const val = checked === true;
                  setUseAllTools(val);
                  setValue('useAllTools', val);
                }}
                disabled={isPending}
              />
              <label htmlFor="useAllTools" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                {t('form.tools.useAllTools')}
              </label>
            </div>
            {!useAllTools && (
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
            )}
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.tools.description')}</p>
          </div>

          {/* MCP Config */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('form.mcpConfig.label')}
              </label>
              {mcpAdvanced && (
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
              )}
            </div>
            {!mcpAdvanced ? (
              <div>
                {mcpRows.length === 0 && (
                  <p className="text-sm text-gray-400 dark:text-gray-500 mb-2">{t('form.mcpConfig.noServers')}</p>
                )}
                {mcpRows.map((row, i) => (
                  <div
                    key={i}
                    className="flex flex-col sm:flex-row gap-2 mb-2 p-3 sm:p-0 border sm:border-0 border-gray-200 dark:border-gray-700 rounded-md"
                  >
                    <Input
                      type="text"
                      value={row.name}
                      placeholder={t('form.mcpConfig.serverNamePlaceholder')}
                      disabled={isPending}
                      onChange={(e) =>
                        applyMcpRows(mcpRows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
                      }
                      className="sm:flex-1"
                    />
                    <Input
                      type="text"
                      value={row.command}
                      placeholder={t('form.mcpConfig.commandPlaceholder')}
                      disabled={isPending}
                      onChange={(e) =>
                        applyMcpRows(mcpRows.map((r, j) => (j === i ? { ...r, command: e.target.value } : r)))
                      }
                      className="sm:flex-1"
                    />
                    <div className="flex gap-2 sm:flex-[2]">
                      <Input
                        type="text"
                        value={row.args}
                        placeholder={t('form.mcpConfig.argsPlaceholder')}
                        disabled={isPending}
                        onChange={(e) =>
                          applyMcpRows(mcpRows.map((r, j) => (j === i ? { ...r, args: e.target.value } : r)))
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={isPending}
                        aria-label={t('form.mcpConfig.removeServer')}
                        onClick={() => applyMcpRows(mcpRows.filter((_, j) => j !== i))}
                        className="flex-shrink-0 text-gray-500 hover:text-red-600 dark:hover:text-red-400"
                      >
                        <XIcon className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() => applyMcpRows([...mcpRows, { name: '', command: '', args: '' }])}
                  className="flex items-center gap-1.5"
                >
                  <PlusIcon className="h-4 w-4" />
                  {t('form.mcpConfig.addServer')}
                </Button>
                {duplicateMcpNames.length > 0 && (
                  <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                    {t('form.mcpConfig.duplicateNames', { names: duplicateMcpNames.join(', ') })}
                  </p>
                )}
              </div>
            ) : (
              <textarea
                {...register('mcpConfig')}
                placeholder={t('form.mcpConfig.placeholder')}
                disabled={isPending}
                rows={8}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical font-mono text-sm"
              />
            )}
            {formState.errors.mcpConfig && (
              <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formState.errors.mcpConfig.message}</p>
            )}
            <div className="flex items-center gap-2 mt-3">
              <Checkbox
                id="mcpAdvanced"
                checked={mcpAdvanced}
                onCheckedChange={(checked) => handleMcpAdvancedToggle(checked === true)}
                disabled={isPending}
              />
              <label htmlFor="mcpAdvanced" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                {t('form.mcpConfig.advancedToggle')}
              </label>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('form.mcpConfig.description')}</p>
          </div>
        </FormSection>

        <FormSection
          step="5"
          title={t('form.sections.runtime.title')}
          description={t('form.sections.runtime.description')}
        >
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
        </FormSection>

        {/* Action Buttons */}
        <div className="flex justify-end gap-3 pt-2">
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
