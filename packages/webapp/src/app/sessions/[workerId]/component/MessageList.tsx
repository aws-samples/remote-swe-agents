'use client';

import React, { useMemo, useState, useCallback } from 'react';
import { Bot, Pause, ChevronUp } from 'lucide-react';
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
  output?: string; // Added for toolResult output JSON
  timestamp: Date;
  type: 'message' | 'toolResult' | 'toolUse' | 'eventTrigger' | 'agentMessage';
  imageKeys?: string[];
  fileKeys?: string[];
  thinkingBudget?: number;
  reasoningText?: string;
  modelOverride?: ModelType;
  pending?: boolean;
  agentName?: string;
  childSessionId?: string;
  /** For agentMessage: sender info */
  senderSessionId?: string;
  senderAgentName?: string;
  /** For agentMessage on parent view: target info */
  targetSessionId?: string;
  targetAgentName?: string;
  /** Whether this is an acknowledge (non-waking) message */
  isAcknowledge?: boolean;
  /** For user messages (type === 'message' && role === 'user'): sender identity */
  userSenderDisplayName?: string;
  userSenderType?: 'slack' | 'webapp' | 'apikey';
  /**
   * Stable per-user identifier for the sender (Cognito sub, Slack user id,
   * API key id, etc.). Used by `getMessageSenderKey` to ensure consecutive
   * user bubbles from DIFFERENT humans are placed in separate groups even
   * when display names happen to collide.
   */
  userSenderUserId?: string;
};

/**
 * Derive a stable key that identifies the *sender* of a message for the
 * purpose of grouping consecutive bubbles in `MessageList`. Two messages with
 * the same key are considered to come from the same source and may share a
 * group; different keys force a new group.
 *
 * Rules:
 *   - assistant / tool / event messages collapse onto a single 'assistant'
 *     bucket per `agentName`; the existing role+agentName check covers this.
 *   - user messages are keyed by `userSenderType + userSenderUserId`. If the
 *     stable id is missing we fall back to the displayName so legacy items
 *     (without sender metadata) still group sensibly. Falling all the way
 *     through yields a single 'user:legacy' bucket which preserves the
 *     pre-feature behaviour.
 */
export function getMessageSenderKey(message: MessageView): string {
  if (message.role !== 'user' || message.type !== 'message') {
    return `${message.role}:${message.agentName ?? ''}`;
  }
  const type = message.userSenderType ?? 'unknown';
  const id = message.userSenderUserId ?? message.userSenderDisplayName ?? 'legacy';
  return `user:${type}:${id}`;
}

export type MessageGroup = {
  role: 'user' | 'assistant';
  messages: MessageView[];
};

const INITIAL_VISIBLE_GROUPS = 50;

type MessageListProps = {
  messages: MessageView[];
  instanceStatus?: 'starting' | 'running' | 'stopped' | 'terminated';
  agentStatus?: 'pending' | 'working' | 'completed';
  onInterrupt: () => void;
  agentIconUrl?: string;
  agentName?: string;
  lastReadAt?: number;
  childSessions?: { workerId: string; title?: string }[];
};

export default function MessageList({
  messages,
  instanceStatus,
  agentStatus,
  onInterrupt,
  agentIconUrl,
  agentName,
  lastReadAt,
  childSessions,
}: MessageListProps) {
  const t = useTranslations('sessions');
  const { userScrolledUp } = useScrollPosition();
  const [showAll, setShowAll] = useState(false);

  const messageGroups = useMemo(() => {
    const groups: MessageGroup[] = [];
    let currentGroup: MessageGroup | null = null;

    messages.forEach((message) => {
      // Agent messages always start a new group (each has its own sender context)
      const isAgentMsg = message.type === 'agentMessage';
      const prevIsAgentMsg = currentGroup?.messages[0]?.type === 'agentMessage';

      // Start a new group when any of the following changes:
      //   - role (user/assistant)
      //   - agentName (assistant identity)
      //   - sender key for user messages (so Alice → Bob in consecutive
      //     user messages renders as two separate Alice / Bob groups
      //     instead of clobbering Bob's bubble with Alice's name).
      //   - agent message boundary (agent-to-agent messages are never merged)
      const currentAgentName = currentGroup?.messages[0]?.agentName;
      const currentSenderKey = currentGroup ? getMessageSenderKey(currentGroup.messages[0]) : undefined;
      const messageSenderKey = getMessageSenderKey(message);
      const isSameSource =
        currentGroup &&
        currentGroup.role === message.role &&
        currentAgentName === message.agentName &&
        currentSenderKey === messageSenderKey &&
        !isAgentMsg &&
        !prevIsAgentMsg;

      if (!isSameSource) {
        currentGroup = {
          role: message.role,
          messages: [message],
        };
        groups.push(currentGroup);
      } else {
        currentGroup!.messages.push(message);
      }
    });

    return groups;
  }, [messages]);

  const hiddenCount = showAll ? 0 : Math.max(0, messageGroups.length - INITIAL_VISIBLE_GROUPS);
  const visibleGroups = hiddenCount > 0 ? messageGroups.slice(hiddenCount) : messageGroups;

  const handleShowAll = useCallback(() => {
    setShowAll(true);
  }, []);

  // Count hidden messages (not groups) for display
  const hiddenMessageCount = useMemo(() => {
    if (hiddenCount === 0) return 0;
    return messageGroups.slice(0, hiddenCount).reduce((acc, g) => acc + g.messages.length, 0);
  }, [messageGroups, hiddenCount]);

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
        // If URL has a #msg-{id} hash, scroll to that message and flash it
        const hash = window.location.hash;
        if (hash.startsWith('#msg-')) {
          const el = document.getElementById(hash.slice(1));
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('search-highlight-flash');
            setTimeout(() => el.classList.remove('search-highlight-flash'), 3000);
            return;
          }
        }
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

  // Find the index of the first assistant group after lastReadAt for the "new messages" divider
  // Use the original full messageGroups index, then adjust for visible offset
  const newMessageGroupIndex = useMemo(
    () =>
      lastReadAt && lastReadAt > 0
        ? messageGroups.findIndex((group) => {
            const firstMsg = group.messages[0];
            return group.role === 'assistant' && firstMsg && new Date(firstMsg.timestamp).getTime() > lastReadAt;
          })
        : -1,
    [lastReadAt, messageGroups]
  );

  // Adjust the new message divider index for truncation offset
  const adjustedNewMessageIndex = newMessageGroupIndex >= 0 ? newMessageGroupIndex - hiddenCount : -1;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-2">
        <div>
          {/* "Show older messages" button - Twitter-style inline */}
          {hiddenCount > 0 && (
            <button onClick={handleShowAll} className="w-full group cursor-pointer">
              <div className="flex items-center gap-3 py-3 px-4 my-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-750 hover:border-gray-300 dark:hover:border-gray-600 transition-all duration-200 shadow-sm">
                <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-50 dark:group-hover:bg-blue-900/30 transition-colors">
                  <ChevronUp className="w-4 h-4 text-gray-400 dark:text-gray-500 group-hover:text-blue-500 transition-colors" />
                </div>
                <span className="text-sm font-medium text-gray-500 dark:text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  {t('showOlderMessages', { count: hiddenMessageCount })}
                </span>
              </div>
            </button>
          )}

          {visibleGroups.map((group, index) => (
            <div key={`group-${hiddenCount + index}`}>
              {index === adjustedNewMessageIndex && adjustedNewMessageIndex >= 0 && (
                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-red-400 dark:bg-red-500" />
                  <span className="text-xs font-semibold text-red-500 dark:text-red-400 whitespace-nowrap">
                    {t('newMessages')}
                  </span>
                  <div className="flex-1 h-px bg-red-400 dark:bg-red-500" />
                </div>
              )}
              <MessageGroupComponent
                group={group}
                agentIconUrl={agentIconUrl}
                agentName={agentName}
                onInterrupt={agentStatus === 'working' ? onInterrupt : undefined}
              />
            </div>
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
                  className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden"
                  style={{ backgroundColor: agentIconUrl ? 'transparent' : '#3B82F6' }}
                >
                  {agentIconUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={agentIconUrl} alt="" className="w-5 h-5 rounded-full object-cover" />
                  ) : (
                    <Bot className="w-3 h-3 text-white" />
                  )}
                </div>
                <span className="text-sm animate-shimmer-text bg-clip-text text-transparent bg-[length:200%_auto]">
                  {instanceStatus === 'starting'
                    ? t('agentStartingMessage')
                    : t('aiAgentResponding', { agentName: agentName || 'Assistant' })}
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
