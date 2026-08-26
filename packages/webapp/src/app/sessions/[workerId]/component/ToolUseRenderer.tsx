import React, { useState } from 'react';
import { Settings, Code, Terminal, Bell, ChevronRight, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePortMapping } from './PortMappingContext';
import { findPortMatches } from '@/lib/port-url-transform';
import { prettifyToolName } from '@remote-swe-agents/agent-core/tool-name-utils';

type ToolUseRendererProps = {
  content: string;
  input: string | undefined;
  output: string | undefined;
  messageId: string;
};

/**
 * Render a plain-text block while turning any `localhost:PORT` / `127.0.0.1:PORT`
 * references that point at currently opened ports into clickable links.
 */
const LinkifiedText = ({ text }: { text: string }) => {
  const mapping = usePortMapping();
  const matches = React.useMemo(() => findPortMatches(text, mapping).filter((m) => m.replacement), [text, mapping]);

  if (matches.length === 0) {
    return <>{text}</>;
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((m, idx) => {
    if (m.start > cursor) {
      nodes.push(text.slice(cursor, m.start));
    }
    nodes.push(
      <a
        key={`port-link-${idx}-${m.start}`}
        href={m.replacement}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 dark:text-blue-400 hover:underline break-all"
      >
        {m.replacement}
      </a>
    );
    cursor = m.end;
  });
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return <>{nodes}</>;
};

export const ToolUseRenderer = ({ content, input, output, messageId }: ToolUseRendererProps) => {
  const t = useTranslations('sessions');
  const [isExpanded, setIsExpanded] = useState(false);
  const toolName = content.split(' + ').map(prettifyToolName).join(' + ');
  const isExecuting = output === undefined;

  const getToolIcon = (name: string) => {
    if (name.includes('execute') || name.includes('Command'))
      return <Terminal className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    if (name.includes('file') || name.includes('edit'))
      return <Code className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    if (name.includes('EventTrigger')) return <Bell className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    return <Settings className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
  };

  return (
    <div className="rounded-md min-w-0">
      <div className="flex items-start gap-2 min-w-0">
        <button onClick={() => setIsExpanded(!isExpanded)} className="flex-shrink-0 mt-0.5">
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
                <span className="text-xs animate-shimmer-text bg-clip-text text-transparent bg-[length:200%_auto]">
                  {t('executing')}
                </span>
              </span>
            )}
          </span>
        </button>
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
              <pre className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">
                {/*
                 * Linkify only the output: dev-server stdout like
                 * "Listening on http://localhost:3000" shows up here, and
                 * turning those into clickable links is the whole point of
                 * Phase 2. Tool input is usually a JSON.stringify of the
                 * arguments — rewriting inside a JSON string is noisy and
                 * rarely useful, so we render it verbatim.
                 */}
                <LinkifiedText text={output} />
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
