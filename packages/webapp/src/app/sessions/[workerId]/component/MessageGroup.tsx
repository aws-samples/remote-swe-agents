import React from 'react';
import Link from 'next/link';
import { Bot, User, Brain, GitBranch } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageView, MessageGroup } from './MessageList';
import { MessageItem } from './MessageItem';
import { formatDateTime } from '@/lib/utils';

type MessageGroupProps = {
  group: MessageGroup;
  agentIconUrl?: string;
  agentName?: string;
  onInterrupt?: () => void;
};

export const MessageGroupComponent = React.memo(function MessageGroupComponent({
  group,
  agentIconUrl,
  agentName,
  onInterrupt,
}: MessageGroupProps) {
  const locale = useLocale();
  const t = useTranslations('sessions');
  const localeForDate = locale === 'ja' ? 'ja-JP' : 'en-US';
  const firstMessage = group.messages[0];
  const firstMessageDate = new Date(firstMessage.timestamp);
  const isChildSessionMessage = !!firstMessage.agentName;
  const childSessionId = firstMessage.childSessionId;
  const isAgentMessage = firstMessage.type === 'agentMessage';

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

  const displayName = isChildSessionMessage
    ? firstMessage.agentName
    : group.role === 'assistant'
      ? agentName || 'Assistant'
      : 'User';

  // Determine icon and styling for agent messages
  const getIcon = () => {
    if (isChildSessionMessage) {
      return (
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-blue-500">
          <GitBranch className="w-4 h-4 text-white" />
        </div>
      );
    }
    if (group.role === 'assistant' && agentIconUrl) {
      /* eslint-disable-next-line @next/next/no-img-element */
      return <img src={agentIconUrl} alt="Agent" className="w-8 h-8 rounded-full object-cover" />;
    }
    return (
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center ${
          group.role === 'assistant' ? 'bg-blue-600' : 'bg-gray-600'
        }`}
      >
        {group.role === 'assistant' ? <Bot className="w-4 h-4 text-white" /> : <User className="w-4 h-4 text-white" />}
      </div>
    );
  };

  // For agent messages, use a more compact style (both parent and child views)
  const containerClass = isAgentMessage
    ? 'mb-2'
    : `mb-3 ${isChildSessionMessage ? 'ml-4 border-l-2 border-blue-200 dark:border-blue-800 pl-3' : ''}`;

  return (
    <div className={containerClass}>
      {/* Hide the full header for agent messages (the renderer handles display) */}
      {!isAgentMessage && (
        <div className="flex items-center gap-3 mb-2">
          <div className="flex-shrink-0">{getIcon()}</div>
          <div className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            {displayName}
            {childSessionId && (
              <Link
                href={`/sessions/${childSessionId}`}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-normal"
              >
                {t('viewChildSession')}
              </Link>
            )}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
            {formatDateTime(firstMessageDate, localeForDate)}
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
      )}

      <div className="space-y-1">
        {group.messages.map((message, index) => {
          const showTimestamp =
            index !== 0 && !isSameTime(new Date(message.timestamp), new Date(group.messages[index - 1].timestamp));
          const isLastExecutingTool =
            message.type === 'toolUse' && message.output === undefined && index === group.messages.length - 1;
          return (
            <MessageItem
              key={message.id}
              message={message}
              showTimestamp={showTimestamp}
              onInterrupt={isLastExecutingTool ? onInterrupt : undefined}
              agentName={agentName}
            />
          );
        })}
      </div>
    </div>
  );
});
