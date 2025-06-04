'use client';

import { Bot, User, Loader2, Clock } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import { useTheme } from 'next-themes';

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  type: 'message' | 'toolResult' | 'toolUse';
};

type MessageListProps = {
  messages: Message[];
  isAgentTyping: boolean;
  instanceStatus?: 'starting' | 'running' | 'sleeping' | 'terminated';
};

export default function MessageList({ messages, isAgentTyping, instanceStatus }: MessageListProps) {
  const { theme } = useTheme();

  const showWaitingMessage = instanceStatus === 'starting';
  const MarkdownRenderer = ({ content }: { content: string }) => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
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
        p: ({ children }) => <p className="mb-2">{children}</p>,
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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-6">
        {showWaitingMessage && (
          <div className="text-center py-4 mb-6 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <Clock className="w-12 h-12 text-yellow-600 dark:text-yellow-400 mx-auto mb-4" />
            <p className="text-yellow-700 dark:text-yellow-300">
              The AI agent is starting up. This may take up to 2 minutes. Please wait...
            </p>
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
                <MarkdownRenderer content={message.content} />
                <div className={`text-xs mt-2 ${'text-gray-500 dark:text-gray-400'}`}>
                  {new Date(message.timestamp).toLocaleTimeString('en-US')}
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
                  <span className="text-gray-600 dark:text-gray-300">AI Agent is responding...</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
