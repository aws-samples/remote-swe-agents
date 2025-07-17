import React from 'react';
import { Bot, User, Brain } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

  // Get thinking budget from assistant messages only
  const thinkingBudget =
    group.role === 'assistant' ? group.messages.find((msg) => msg.thinkingBudget)?.thinkingBudget || 0 : 0;

  const getBrainColor = (budget: number): string => {
    if (budget === 0) return 'text-gray-300 dark:text-gray-600';
    if (budget < 1000) return 'text-gray-400 dark:text-gray-500';
    if (budget < 5000) return 'text-gray-500 dark:text-gray-400';
    if (budget < 10000) return 'text-gray-600 dark:text-gray-300';
    if (budget < 20000) return 'text-gray-700 dark:text-gray-200';
    return 'text-gray-800 dark:text-gray-100';
  };

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
        <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
          {firstMessageDate.toLocaleDateString(localeForDate)}{' '}
          {firstMessageDate.toLocaleTimeString(localeForDate, { hour: '2-digit', minute: '2-digit' })}
          {group.role === 'assistant' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="ml-2">
                  <Brain className={`w-4 h-4 ${getBrainColor(thinkingBudget)}`} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {group.messages.find((msg) => msg.thinkingBudget)
                    ? `${t('thinkingBudget')}: ${thinkingBudget.toLocaleString()}`
                    : `${t('thinkingBudget')}: ${t('defaultThinkingBudget')}`}
                </p>
                {!group.messages.find((msg) => msg.thinkingBudget) && (
                  <p className="text-xs mt-1">{t('ultrathinkInstruction')}</p>
                )}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
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
