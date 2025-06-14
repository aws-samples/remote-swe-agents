import React, { useState } from 'react';
import { Loader2, Settings, Code, Terminal, ChevronRight, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

type ToolUseRendererProps = {
  content: string;
  input: string | undefined;
  output: string | undefined;
  messageId: string;
};

export const ToolUseRenderer = ({ content, input, output, messageId }: ToolUseRendererProps) => {
  const t = useTranslations('sessions');
  const [isExpanded, setIsExpanded] = useState(false);
  const toolName = content;
  const isExecuting = output === undefined;

  const getToolIcon = (name: string) => {
    if (name.includes('execute') || name.includes('Command'))
      return <Terminal className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    if (name.includes('file') || name.includes('edit'))
      return <Code className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    return <Settings className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
  };

  return (
    <div className="rounded-md">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 cursor-pointer hover:underline p-2 -m-2"
      >
        <div className="flex items-baseline gap-2">
          {getToolIcon(toolName)}
          <span className="flex items-baseline gap-2">
            <span className="hidden md:inline">{t('usingTool')}: </span>
            <span className="truncate">{toolName}</span>
            {isExecuting && (
              <div className="flex items-baseline gap-1 ml-2">
                <Loader2 className="w-3 h-3 animate-spin text-gray-500" />
                <span className="text-xs text-gray-500 dark:text-gray-400">{t('executing')}</span>
              </div>
            )}
          </span>
        </div>
        <div className="flex-shrink-0">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="mt-2 space-y-2">
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
