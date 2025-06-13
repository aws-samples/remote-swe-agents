'use client';

import React, { useLayoutEffect, useRef } from 'react';
import { Bot, User, Loader2, Clock, Info, Settings, Code, Terminal, ChevronRight, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import { useTheme } from 'next-themes';
import { useTranslations, useLocale } from 'next-intl';
import { useEffect, useState } from 'react';
import { useScrollPosition } from '@/hooks/use-scroll-position';

export type MessageView = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  detail?: string;
  output?: string; // Added for toolResult output JSON
  timestamp: Date;
  type: 'message' | 'toolResult' | 'toolUse';
};

type MessageGroup = {
  role: 'user' | 'assistant';
  messages: MessageView[];
};

type MessageListProps = {
  messages: MessageView[];
  instanceStatus?: 'starting' | 'running' | 'stopped' | 'terminated';
  agentStatus?: 'pending' | 'working' | 'completed';
};

export default function MessageList({ messages, instanceStatus, agentStatus }: MessageListProps) {
  const { theme, resolvedTheme } = useTheme();
  const t = useTranslations('sessions');
  const locale = useLocale();
  const localeForDate = locale === 'ja' ? 'ja-JP' : 'en-US';
  const positionRatio = useScrollPosition();
  // Track visibility of tool details for each message
  const [visibleToolDetails, setVisibleToolDetails] = useState<Set<string>>(new Set());
  const scrollPositionRef = useRef<number>(0);

  const toggleToolDetailsVisibility = (messageId: string) => {
    scrollPositionRef.current = window.scrollY;

    setVisibleToolDetails((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  };

  // to keep scroll position before/after toggle
  useLayoutEffect(() => {
    window.scrollTo({ top: scrollPositionRef.current, behavior: 'instant' });
  }, [visibleToolDetails]);

  const groupMessages = (messages: MessageView[]): MessageGroup[] => {
    const groups: MessageGroup[] = [];
    let currentGroup: MessageGroup | null = null;

    messages.forEach((message) => {
      if (!currentGroup || currentGroup.role !== message.role) {
        currentGroup = {
          role: message.role,
          messages: [message],
        };
        groups.push(currentGroup);
      } else {
        currentGroup.messages.push(message);
      }
    });

    return groups;
  };

  useEffect(() => {
    if (positionRatio > 0.95) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  const MarkdownRenderer = ({ content }: { content: string }) => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => {
          if (typeof children === 'string') {
            const parts = children.split('\n');
            return (
              <p className="mb-2">
                {parts.map((part, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <br />}
                    {part}
                  </React.Fragment>
                ))}
              </p>
            );
          }
          return <p className="mb-2">{children}</p>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code(props: any) {
          const { className, children } = props;
          const match = /language-(\w+)/.exec(className || '');
          const isInline = !match;
          return !isInline ? (
            <SyntaxHighlighter
              style={resolvedTheme === 'dark' ? oneDark : oneLight}
              lineProps={{ style: { wordBreak: 'break-word', whiteSpace: 'pre-wrap' } }}
              language={match[1]}
              PreTag="div"
              className="rounded-md"
              wrapLines
              wrapLongLines
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          ) : (
            <code className="bg-gray-200 dark:bg-gray-600 px-1 py-0.5 rounded text-sm whitespace-pre-wrap">
              {children}
            </code>
          );
        },
        h1: ({ children }) => <h1 className="text-2xl font-bold mb-4">{children}</h1>,
        h2: ({ children }) => <h2 className="text-xl font-bold mb-3">{children}</h2>,
        h3: ({ children }) => <h3 className="text-lg font-bold mb-2">{children}</h3>,

        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
        li: ({ children }) => <li className="ml-2">{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic mb-2">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-blue-600 dark:text-blue-400 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
        strong: ({ children }) => <strong className="font-bold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
      }}
    >
      {content}
    </ReactMarkdown>
  );

  // Utility function to compare timestamps (hour:minute format)
  const isSameTime = (timestamp1: Date, timestamp2: Date): boolean => {
    return timestamp1.getHours() === timestamp2.getHours() && timestamp1.getMinutes() === timestamp2.getMinutes();
  };

  const ToolUseRenderer = ({
    content,
    input,
    output,
    messageId,
  }: {
    content: string;
    input: string | undefined;
    output: string | undefined;
    messageId: string;
  }) => {
    const toolName = content;
    const isExecuting = output === undefined;
    const isExpanded = visibleToolDetails.has(messageId);

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
          onClick={() => toggleToolDetailsVisibility(messageId)}
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

  const MessageItem = ({ message, showTimestamp = true }: { message: MessageView; showTimestamp?: boolean }) => (
    <div className="flex items-start gap-1 py-1">
      <div
        className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0 mt-1 md:block hidden"
        style={{ minWidth: '55px' }}
      >
        {showTimestamp &&
          new Date(message.timestamp).toLocaleTimeString(localeForDate, { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="flex-1">
        {message.type === 'toolUse' ? (
          <ToolUseRenderer
            content={message.content}
            input={message.detail}
            output={message.output}
            messageId={message.id}
          />
        ) : (
          <div
            className={`text-gray-900 dark:text-white pb-2 break-all${message.role == 'user' ? ' whitespace-pre-wrap' : ''}`}
          >
            <MarkdownRenderer content={message.content} />
          </div>
        )}
      </div>
    </div>
  );

  const MessageGroup = ({ group }: { group: MessageGroup }) => {
    const firstMessage = group.messages[0];
    const firstMessageDate = new Date(firstMessage.timestamp);

    return (
      <div className="mb-3">
        {/* Group Header */}
        <div className="flex items-center gap-3 mb-2">
          <div className="flex-shrink-0">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                group.role === 'assistant' ? 'bg-blue-600' : 'bg-gray-600'
              }`}
            >
              {group.role === 'assistant' ? (
                <Bot className="w-4 h-4 text-white" />
              ) : (
                <User className="w-4 h-4 text-white" />
              )}
            </div>
          </div>
          <div className="font-semibold text-gray-900 dark:text-white">
            {group.role === 'assistant' ? 'Assistant' : 'User'}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {firstMessageDate.toLocaleDateString(localeForDate)}{' '}
            {firstMessageDate.toLocaleTimeString(localeForDate, { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

        {/* Messages */}
        <div className="space-y-1">
          {group.messages.map((message, index) => {
            const showTimestamp =
              index !== 0 && !isSameTime(new Date(message.timestamp), new Date(group.messages[index - 1].timestamp));
            return <MessageItem key={message.id} message={message} showTimestamp={showTimestamp} />;
          })}
        </div>
      </div>
    );
  };

  const messageGroups = groupMessages(messages);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div>
          {messageGroups.map((group, index) => (
            <MessageGroup key={`group-${index}`} group={group} />
          ))}

          {(agentStatus === 'working' || instanceStatus === 'starting') && (
            <div className="mb-6">
              <div className="flex items-center gap-3 mb-2">
                <div className="flex-shrink-0">
                  <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
                    <Bot className="w-4 h-4 text-white" />
                  </div>
                </div>
                <div className="font-semibold text-gray-900 dark:text-white">Assistant</div>
              </div>
              <div className="md:ml-11">
                <div className="flex items-center gap-2 py-1">
                  <Loader2 className="w-4 h-4 animate-spin text-gray-600 dark:text-gray-400" />
                  <span className="text-gray-600 dark:text-gray-300">
                    {instanceStatus === 'starting' ? t('agentStartingMessage') : t('aiAgentResponding')}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
