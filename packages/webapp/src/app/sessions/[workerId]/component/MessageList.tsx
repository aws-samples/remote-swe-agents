'use client';

import React, { useMemo } from 'react';
import { Bot, Pause } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { useScrollPosition } from '@/hooks/use-scroll-position';
import { MessageGroupComponent } from './MessageGroup';
import { ModelType } from '@remote-swe-agents/agent-core/schema';

export type MessageView = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  detail?: string;
  output?: string;
  timestamp: Date;
  type: 'message' | 'toolResult' | 'toolUse' | 'eventTrigger';
  imageKeys?: string[];
  thinkingBudget?: number;
  reasoningText?: string;
  modelOverride?: ModelType;
  pending?: boolean;
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
  const { userScrolledUp } = useScrollPosition();

  const messageGroups = useMemo(() => {
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
  }, [messages]);

  // Auto-scroll when new messages arrive
  // Only skip auto-scroll if user has intentionally scrolled up (reading history)
  useEffect(() => {
    if (!userScrolledUp) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  // Scroll to bottom on initial page load
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (!initialScrollDone.current && messages.length > 0) {
      initialScrollDone.current = true;
      // Use requestAnimationFrame to ensure DOM is rendered
      requestAnimationFrame(() => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
      });
    }
  }, [messages]);

  // Check if the last message is a toolUse that is still executing (no output yet)
  const lastMessage = messages[messages.length - 1];
  const isToolExecuting = lastMessage?.type === 'toolUse' && lastMessage.output === undefined;

  // Show the loading indicator when agent is working or instance is starting,
  // but NOT when a tool is currently executing (ToolUseRenderer already shows "Executing..." spinner)
  const showLoadingIndicator = (agentStatus === 'working' && !isToolExecuting) || instanceStatus === 'starting';

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-2">
        <div>
          {messageGroups.map((group, index) => (
            <MessageGroupComponent
              key={`group-${index}`}
              group={group}
              onInterrupt={agentStatus === 'working' ? onInterrupt : undefined}
            />
          ))}
        </div>
      </div>

      {/* Typing indicator - shown near the input area like Slack's "is typing..." */}
      {showLoadingIndicator && (
        <div className="sticky bottom-0 bg-gray-50 dark:bg-gray-900">
          <div className="max-w-4xl mx-auto px-4 py-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: '#3B82F6' }}
                >
                  <Bot className="w-3 h-3 text-white" />
                </div>
                <span className="text-sm animate-shimmer-text bg-clip-text text-transparent bg-[length:200%_auto]">
                  {instanceStatus === 'starting' ? t('agentStartingMessage') : t('aiAgentResponding')}
                </span>
              </div>
              {agentStatus === 'working' && (
                <button
                  onClick={onInterrupt}
                  className="flex items-center px-4 py-1.5 text-sm bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-300 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                >
                  <Pause className="w-4 h-4 mr-2" />
                  {t('interrupt')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
