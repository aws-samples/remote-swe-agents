'use client';

import React from 'react';
import { Bot, Loader2, Square } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { useScrollPosition } from '@/hooks/use-scroll-position';
import { MessageGroupComponent } from './MessageGroup';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

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
  onInterrupt: () => void;
};

export default function MessageList({ messages, instanceStatus, agentStatus, onInterrupt }: MessageListProps) {
  const t = useTranslations('sessions');
  const { isBottom } = useScrollPosition();

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
    if (isBottom) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  const messageGroups = groupMessages(messages);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-2">
        <div>
          {messageGroups.map((group, index) => (
            <MessageGroupComponent key={`group-${index}`} group={group} />
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
                  {agentStatus === 'working' && (
                    <TooltipProvider delayDuration={100}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={onInterrupt}
                            className="ml-2 flex items-center gap-1 px-2 py-1 text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                          >
                            <Square className="w-3 h-3" />
                            {t('interrupt')}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t('interruptToolTip')}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
