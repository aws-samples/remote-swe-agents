'use client';

import { Bot, User, Loader2, Clock } from 'lucide-react';

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  type?: 'message' | 'progress' | 'tool_use';
};

type MessageListProps = {
  messages: Message[];
  isAgentTyping: boolean;
};

export default function MessageList({ messages, isAgentTyping }: MessageListProps) {
  console.log(messages);
  // Check if there are any assistant messages and the last message was within 10 minutes
  const showWaitingMessage =
    messages.some((msg) => msg.role === 'assistant') &&
    new Date(messages.at(-1)?.timestamp ?? new Date()).getTime() - Date.now() < 10 * 60 * 1000;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-6">
        {showWaitingMessage && (
          <div className="text-center py-12 mb-6 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <Clock className="w-12 h-12 text-yellow-600 dark:text-yellow-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-yellow-800 dark:text-yellow-200 mb-2">EC2 Instance Starting</h3>
            <p className="text-yellow-700 dark:text-yellow-300">
              The AI agent is starting up. This may take up to 2 minutes. Please wait...
            </p>
          </div>
        )}
        {messages.length === 0 && !showWaitingMessage ? (
          <div className="text-center py-12">
            <Bot className="w-12 h-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              Let&apos;s start the conversation
            </h3>
            <p className="text-gray-600 dark:text-gray-300">
              Send questions or requests to the AI agent using the message input below
            </p>
          </div>
        ) : messages.length > 0 ? (
          <div className="space-y-6">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex gap-4 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {message.role === 'assistant' && (
                  <div className="flex-shrink-0">
                    <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
                      <Bot className="w-4 h-4 text-white" />
                    </div>
                  </div>
                )}

                <div
                  className={`max-w-3xl rounded-lg px-4 py-3 ${
                    message.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : message.type === 'progress'
                        ? 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'
                  }`}
                >
                  <div className="whitespace-pre-wrap">{message.content}</div>
                  <div
                    className={`text-xs mt-2 ${
                      message.role === 'user' ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'
                    }`}
                  >
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
        ) : null}
      </div>
    </div>
  );
}
