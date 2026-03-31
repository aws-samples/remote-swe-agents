import React, { useState } from 'react';
import { Settings, Code, Terminal, Bell, ChevronRight, ChevronDown, Pause } from 'lucide-react';
import { useTranslations } from 'next-intl';

type ToolUseRendererProps = {
  content: string;
  input: string | undefined;
  output: string | undefined;
  messageId: string;
  onInterrupt?: () => void;
};

export const ToolUseRenderer = ({ content, input, output, messageId, onInterrupt }: ToolUseRendererProps) => {
  const t = useTranslations('sessions');
  const [isExpanded, setIsExpanded] = useState(false);
  const toolName = content;
  const isExecuting = output === undefined;

  const getToolIcon = (name: string) => {
    if (name.includes('execute') || name.includes('Command'))
      return <Terminal className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    if (name.includes('file') || name.includes('edit'))
      return <Code className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    if (name.includes('EventTrigger'))
      return <Bell className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    return <Settings className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
  };

  return (
    <div className="rounded-md min-w-0">
      <div className="flex items-start gap-2 min-w-0">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-shrink-0 mt-0.5"
        >
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          )}
        </button>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 flex items-start text-left text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 cursor-pointer hover:underline min-w-0"
        >
          <span className="mt-0.5 flex-shrink-0 mr-2">{getToolIcon(toolName)}</span>
          <span className="min-w-0">
            <span className="hidden md:inline">{t('usingTool')}: </span>
            <span className="break-words">{toolName}</span>
            {isExecuting && (
              <span className="inline-flex items-baseline gap-1 ml-2">
                <span className="text-xs animate-gaming-led bg-clip-text text-transparent bg-[length:200%_auto]">{t('executing')}</span>
              </span>
            )}
          </span>
        </button>
        {isExecuting && onInterrupt && (
          <button
            onClick={(e) => { e.stopPropagation(); onInterrupt(); }}
            className="flex-shrink-0 flex items-center px-4 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
          >
            <Pause className="w-4 h-4 mr-2" />
            {t('interrupt')}
          </button>
        )}
      </div>

      {isExpanded && (
        <div className="mt-2 ml-6 space-y-2">
          {input && (
            <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded overflow-auto max-h-60">
              <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t('input')}:</div>
              <pre className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">{input}</pre>
            </div>
          )}
          {output && (
            <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded overflow-auto max-h-60">
              <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{t('output')}:</div>
              <pre className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
