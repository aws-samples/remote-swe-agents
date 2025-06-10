'use client';

import React from 'react';
import { Bot, User, Loader2, Clock, Info, Settings, Code, Terminal, ChevronRight, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
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

type MessageListProps = {
  messages: MessageView[];
  isAgentTyping: boolean;
  instanceStatus?: 'starting' | 'running' | 'stopped' | 'terminated';
};

export default function MessageList({ messages, isAgentTyping, instanceStatus }: MessageListProps) {
  const { theme } = useTheme();
  const t = useTranslations('sessions');
  const positionRatio = useScrollPosition();
  // Track visibility of input and output JSON for each message
  const [visibleInputJsonMessages, setVisibleInputJsonMessages] = useState<Set<string>>(new Set());
  const [visibleOutputJsonMessages, setVisibleOutputJsonMessages] = useState<Set<string>>(new Set());

  const toggleInputJsonVisibility = (messageId: string) => {
    setVisibleInputJsonMessages((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  };

  const toggleOutputJsonVisibility = (messageId: string) => {
    setVisibleOutputJsonMessages((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  };

  useEffect(() => {
    if (positionRatio > 0.95) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  const showWaitingMessage = instanceStatus === 'starting';
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
              style={theme === 'dark' ? oneDark : oneLight}
              language={match[1]}
              PreTag="div"
              className="rounded-md"
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          ) : (
            <code className="bg-gray-200 dark:bg-gray-600 px-1 py-0.5 rounded text-sm">{children}</code>
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

    const getToolIcon = (name: string) => {
      if (name.includes('execute') || name.includes('Command')) return <Terminal className="w-4 h-4" />;
      if (name.includes('file') || name.includes('edit')) return <Code className="w-4 h-4" />;
      return <Settings className="w-4 h-4" />;
    };

    return (
      <div>
        <div className="flex items-center gap-2 mb-2">
          {getToolIcon(toolName)}
          <span className="font-semibold">
            {t('usingTool')}: {toolName}
          </span>
          <div className="flex items-center gap-2">
            {input && (
              <button
                onClick={() => toggleInputJsonVisibility(messageId)}
                className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400 hover:underline text-xs ml-2"
              >
                {visibleInputJsonMessages.has(messageId) ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                <span>{t('input')}</span>
              </button>
            )}
            {output && (
              <button
                onClick={() => toggleOutputJsonVisibility(messageId)}
                className="flex items-center gap-1 text-green-600 dark:text-green-400 hover:underline text-xs ml-2"
              >
                {visibleOutputJsonMessages.has(messageId) ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                <span>{t('output')}</span>
              </button>
            )}
          </div>
        </div>

        {input && visibleInputJsonMessages.has(messageId) && (
          <div className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded overflow-auto max-h-60">
            <pre className="text-xs">{input}</pre>
          </div>
        )}

        {output && visibleOutputJsonMessages.has(messageId) && (
          <div className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded overflow-auto max-h-60">
            <pre className="text-xs text-green-600 dark:text-green-400">{output}</pre>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-6">
        {showWaitingMessage && (
          <div className="text-center py-4 mb-6 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <Clock className="w-12 h-12 text-yellow-600 dark:text-yellow-400 mx-auto mb-4" />
            <p className="text-yellow-700 dark:text-yellow-300">{t('agentStartingMessage')}</p>
          </div>
        )}
        <div className="space-y-6">
          {messages.map((message) => (
            <div key={message.id} className={`flex gap-4 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {message.role === 'assistant' && (
                <div className="flex-shrink-0">
                  <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
                    <Bot className="w-4 h-4 text-white" />
                  </div>
                </div>
              )}

              <div
                className={`max-w-3xl rounded-lg px-4 py-3 ${
                  message.type === 'toolUse'
                    ? 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'
                }`}
              >
                {message.type === 'toolUse' ? (
                  <ToolUseRenderer
                    content={message.content}
                    input={message.detail}
                    output={message.output}
                    messageId={message.id}
                  />
                ) : (
                  <MarkdownRenderer content={message.content} />
                )}
                <div className={`text-xs mt-2 ${'text-gray-500 dark:text-gray-400'}`}>
                  {new Date(message.timestamp).toLocaleDateString()} {new Date(message.timestamp).toLocaleTimeString()}
                </div>
              </div>

              {message.role === 'user' && (
                <div className="flex-shrink-0">
                  <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center">
                    <User className="w-4 h-4 text-white" />
                  </div>
                </div>
              )}
            </div>
          ))}

          {isAgentTyping && (
            <div className="flex gap-4 justify-start">
              <div className="flex-shrink-0">
                <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
                  <Bot className="w-4 h-4 text-white" />
                </div>
              </div>
              <div className="bg-gray-100 dark:bg-gray-700 rounded-lg px-4 py-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-gray-600 dark:text-gray-300">{t('aiAgentResponding')}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
