import React from 'react';
import { Bot, User } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { MessageView } from './MessageList';
import { MessageItem } from './MessageItem';

type MessageGroup = {
  role: 'user' | 'assistant';
  messages: MessageView[];
};

type MessageGroupProps = {
  group: MessageGroup;
};

export const MessageGroupComponent = ({ group }: MessageGroupProps) => {
  const locale = useLocale();
  const t = useTranslations('sessions');
  const localeForDate = locale === 'ja' ? 'ja-JP' : 'en-US';
  const firstMessage = group.messages[0];
  const firstMessageDate = new Date(firstMessage.timestamp);

  const isSameTime = (timestamp1: Date, timestamp2: Date): boolean => {
    return timestamp1.getHours() === timestamp2.getHours() && timestamp1.getMinutes() === timestamp2.getMinutes();
  };

  // Check if any message in the group has thinkingBudget
  const thinkingBudget =
    group.role === 'assistant'
      ? group.messages.find((msg) => msg.thinkingBudget !== undefined)?.thinkingBudget
      : undefined;

  return (
    <div className="mb-3">
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
        {thinkingBudget && (
          <div className="ml-auto">
            <div className="px-2 py-1 bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 rounded text-xs font-medium">
              <span className="hidden sm:inline">{t('thinkingBudget')}: </span>
              <span>{thinkingBudget.toLocaleString()} tokens</span>
            </div>
          </div>
        )}
      </div>

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
