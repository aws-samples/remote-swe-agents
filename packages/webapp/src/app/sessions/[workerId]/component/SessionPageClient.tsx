'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { computeTotalUnread } from '@/lib/unread-display';
import Header from '@/components/Header';
import { ListChecks, Check, Circle, Plus, Loader2, Menu, ChevronDown, Square, ArrowRightLeft } from 'lucide-react';
import { useScrollPosition } from '@/hooks/use-scroll-position';
import Link from 'next/link';
import { useAction } from 'next-safe-action/hooks';
import {
  updateAgentStatus,
  sendEventToAgent,
  stopSession,
  handoverSession,
  markSessionReadAction,
  rewindSessionAction,
  undoRewindAction,
} from '../actions';
import { markAllReadAction } from '@/actions/badge/action';
import { mergeDuplicateUserRebroadcast } from './dedup';
import { isPreviewRendered } from './message-consistency';
import { raiseMissedEvents, clearMissedEvents } from '@/lib/missed-events-signal';
import { useEventBus } from '@/hooks/use-event-bus';
import MessageForm from './MessageForm';
import MessageList, { MessageView } from './MessageList';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  webappEventSchema,
  TodoList as TodoListType,
  AgentStatus,
  InstanceStatus,
  GlobalPreferences,
  SessionItem,
  InferenceMode,
} from '@remote-swe-agents/agent-core/schema';
import { useTranslations } from 'next-intl';
import TodoList from './TodoList';
import { getUnifiedStatus } from '@/utils/session-status';
import { fetchLatestTodoList } from '../actions';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { formatMessage } from '@/lib/message-formatter';
import HandoverModal from './HandoverModal';
import SessionSidebar from './SessionSidebar';
import SessionContentSearch from './SessionContentSearch';
import { ArrowLeft } from 'lucide-react';
import { useSwipeGesture } from '@/hooks/use-swipe-gesture';

interface SessionPageClientProps {
  workerId: string;
  userId: string;
  preferences: GlobalPreferences;
  initialTitle: string | undefined;
  initialMessages: MessageView[];
  initialInstanceStatus?: InstanceStatus;
  initialAgentStatus?: AgentStatus;
  initialTodoList: TodoListType | null;
  allSessions: SessionItem[];
  agentIconUrl?: string;
  agentName?: string;
  unreadMap?: Record<string, { unreadCount: number; hasPending: boolean }>;
  lastReadAt?: number;
  childSessions?: { workerId: string; title?: string }[];
  parentSessionId?: string;
  /**
   * Display name of the signed-in user, forwarded to `MessageForm` so the
   * optimistic bubble is labelled with the submitter's own name.
   */
  currentUserDisplayName?: string;
  /**
   * Effective inference mode for this session, resolved server-side via the
   * priority chain (session > customAgent > userPreferences > env > default).
   * When `'kiro-cli'`, the chat input shows the Kiro model selector instead
   * of the Bedrock model picker.
   */
  inferenceMode?: InferenceMode;
  /**
   * Kiro model baked into the session (or inherited from user preferences for
   * legacy sessions). Only meaningful when `inferenceMode === 'kiro-cli'`.
   */
  kiroModel?: string;
  initialRewindHiddenCount?: number;
}

/**
 * Grace window after a `lastMessageUpdate` whose preview has no matching
 * bubble, before assuming the drawing event was truly dropped. Covers the
 * normal ordering race where the bubble event arrives a beat later on a
 * separate emit path; if it shows up within this window the refresh is
 * cancelled.
 */
const CONSISTENCY_REFRESH_DEBOUNCE_MS = 2500;

/**
 * Minimum spacing between consistency-triggered `router.refresh()` calls.
 * Combined with same-preview suppression, prevents any chance of a refresh
 * loop if the server snapshot somehow keeps lacking the previewed message.
 */
const CONSISTENCY_REFRESH_MIN_INTERVAL_MS = 3000;

export default function SessionPageClient({
  workerId,
  userId,
  preferences,
  initialTitle,
  initialMessages,
  initialInstanceStatus,
  initialAgentStatus,
  initialTodoList,
  allSessions,
  agentIconUrl,
  agentName,
  unreadMap,
  lastReadAt,
  parentSessionId,
  inferenceMode,
  kiroModel,
  currentUserDisplayName,
  initialRewindHiddenCount,
}: SessionPageClientProps) {
  const t = useTranslations('sessions');
  const router = useRouter();
  // Self-recovery bookkeeping for the `lastMessageUpdate` consistency
  // check (see the `lastMessageUpdate` case below). Refs, not state, so
  // updating them never triggers a re-render.
  const lastConsistencyRefreshAtRef = useRef(0);
  const recoveredPreviewRef = useRef<string | null>(null);
  const consistencyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<MessageView[]>(initialMessages);
  const [messages, setMessages] = useState<MessageView[]>(initialMessages);
  const [instanceStatus, setInstanceStatus] = useState<InstanceStatus | undefined>(initialInstanceStatus);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | undefined>(initialAgentStatus);
  const [todoList, setTodoList] = useState<TodoListType | null>(initialTodoList);
  const [sessionTitle, setSessionTitle] = useState(initialTitle ?? '');

  // Update state when props change (e.g., on refresh)
  useEffect(() => {
    setMessages(initialMessages);
  }, [initialMessages]);

  // Mirror `messages` into a ref so the debounced consistency re-check
  // reads the CURRENT bubbles, not the ones captured when the timer armed.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Clear any pending consistency timer on unmount, and drop any pending
  // missed-events signal so it cannot leak across a client-side navigation
  // (the signal is tab-global; a different page must not inherit this
  // session's raise).
  useEffect(() => {
    return () => {
      if (consistencyTimerRef.current) {
        clearTimeout(consistencyTimerRef.current);
        consistencyTimerRef.current = null;
      }
      clearMissedEvents();
    };
  }, []);

  useEffect(() => {
    setInstanceStatus(initialInstanceStatus);
  }, [initialInstanceStatus]);

  useEffect(() => {
    setAgentStatus(initialAgentStatus);
  }, [initialAgentStatus]);

  useEffect(() => {
    setTodoList(initialTodoList);
  }, [initialTodoList]);

  const [showTodoModal, setShowTodoModal] = useState(false);
  const [showHandoverModal, setShowHandoverModal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentUnreadMap, setCurrentUnreadMap] = useState(unreadMap ?? {});
  const { isBottom, isHeaderVisible } = useScrollPosition();

  useSwipeGesture({
    onSwipeRight: useCallback(() => setSidebarOpen(true), []),
    onSwipeLeft: useCallback(() => setSidebarOpen(false), []),
  });

  // Mark session as read and update badge
  const { execute: executeMarkRead } = useAction(markSessionReadAction, {
    onSuccess: ({ data }) => {
      // Clear current session from unread map
      setCurrentUnreadMap((prev) => {
        const next = { ...prev };
        delete next[workerId];
        return next;
      });

      if (data?.badge && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'UPDATE_BADGE',
          badge: data.badge,
        });
      }

      window.dispatchEvent(new CustomEvent('session-read'));
    },
  });

  // Mark as read on mount
  useEffect(() => {
    executeMarkRead({ workerId });
  }, [workerId]);

  // Mark all sessions as read
  const { execute: executeMarkAllRead, isExecuting: isMarkingAllRead } = useAction(markAllReadAction, {
    onSuccess: ({ data }) => {
      setCurrentUnreadMap({});
      window.dispatchEvent(new CustomEvent('session-read'));

      // Clear OS badge
      if (data?.badge && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'UPDATE_BADGE',
          badge: data.badge,
        });
      }
    },
  });

  // Setup event handler for Escape key press to force stop agent work
  const { execute: sendEvent } = useAction(sendEventToAgent, {
    onExecute: () => {
      toast.success(t('forceStopInProgress'));
    },
    onError: (error) => {
      toast.error(`${t('forceStopError')}: ${error?.error?.serverError || error}`);
    },
  });

  const handleInterrupt = useCallback(() => {
    if (agentStatus === 'working') {
      sendEvent({
        workerId,
        event: { type: 'forceStop' },
      });
    }
  }, [workerId, agentStatus, sendEvent]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleInterrupt();
      }
    },
    [handleInterrupt]
  );

  // Add and remove event listener for Escape key
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  // Rewind state: tracks how many messages are hidden
  const [rewindHiddenCount, setRewindHiddenCount] = useState(initialRewindHiddenCount ?? 0);

  const { execute: executeRewind } = useAction(rewindSessionAction, {
    onSuccess: () => {
      toast.success(t('revertSuccess'));
      router.refresh();
    },
    onError: (error) => {
      toast.error(t('revertFailed'));
    },
  });

  const { execute: executeUndoRewind } = useAction(undoRewindAction, {
    onSuccess: () => {
      toast.success(t('undoRewindSuccess'));
      setRewindHiddenCount(0);
      router.refresh();
    },
    onError: (error) => {
      toast.error(t('undoRewindFailed'));
    },
  });

  const handleRewind = useCallback(
    (messageId: string) => {
      if (agentStatus === 'working') {
        toast.error(t('rewindDisabledWorking'));
        return;
      }
      // Extract SK from message id (format: `${SK}-${index}` or `${SK}-${i}-${toolUseId}`)
      const skMatch = messageId.match(/^(\d{15})/);
      if (!skMatch) return;
      const cutoffSK = skMatch[1];

      // Count how many messages will be hidden (those after the cutoff)
      const hiddenMessages = messages.filter((m) => {
        const msgSK = m.id.match(/^(\d{15})/)?.[1];
        return msgSK && msgSK > cutoffSK;
      });
      setRewindHiddenCount(hiddenMessages.length);

      executeRewind({ workerId, cutoffSK });
    },
    [workerId, agentStatus, messages, executeRewind, t]
  );

  const handleUndoRewind = useCallback(() => {
    executeUndoRewind({ workerId });
  }, [workerId, executeUndoRewind]);

  const getSessionStatus = () => {
    const status = getUnifiedStatus(agentStatus, instanceStatus);
    return {
      text: t(status.i18nKey),
      color: status.color,
    };
  };

  // Refetch todoList function using safe action
  const { execute: refetchTodoList, isExecuting: isRefetchingTodoList } = useAction(fetchLatestTodoList, {
    onSuccess: ({ data }) => {
      if (data.todoList) {
        setTodoList(data.todoList);
      }
    },
  });

  // Real-time communication via event bus
  useEventBus({
    channelName: `webapp/worker/${workerId}`,
    onReceived: useCallback(
      (payload: unknown) => {
        console.log('Received event:', payload);
        const event = webappEventSchema.parse(payload);

        // Mark session as read since user is viewing it
        if (event.type === 'message' || event.type === 'toolUse') {
          executeMarkRead({ workerId });
        }
        if (event.type === 'agentStatusUpdate' && event.status === 'pending') {
          executeMarkRead({ workerId });
        }

        switch (event.type) {
          case 'message':
            if (event.message) {
              const cleanedMessage = formatMessage(event.message);
              // Only add message if it's not empty after removing mentions
              if (cleanedMessage) {
                setMessages((prev) => {
                  // Dedup: see `mergeDuplicateUserRebroadcast`. The dedup
                  // identifier is the per-submission UUID (`event.clientId`)
                  // that `MessageForm` stamped on the optimistic bubble and
                  // the server action forwarded back via the rebroadcast.
                  // A match means "this echo IS my own submit" — but instead
                  // of dropping the event wholesale, the event's attachment
                  // keys are merged onto the existing bubble. The rebroadcast
                  // is the only realtime carrier of imageKeys/fileKeys back
                  // to the submitter's own tab, so a drop-only dedup would
                  // leave the submitter unable to see their own attachments
                  // until a full server re-render.
                  if (event.role === 'user') {
                    const merged = mergeDuplicateUserRebroadcast(prev, event.clientId, {
                      imageKeys: event.imageKeys,
                      fileKeys: event.fileKeys,
                    });
                    if (merged) {
                      return merged;
                    }
                  }
                  const newMsgId = event.messageSK ? `${event.messageSK}-0` : Date.now().toString();
                  if (event.messageSK && prev.some((m) => m.id === newMsgId)) return prev;
                  return [
                    ...prev,
                    {
                      id: newMsgId,
                      role: event.role,
                      content: cleanedMessage,
                      timestamp: event.messageSK ? new Date(parseInt(event.messageSK)) : new Date(event.timestamp),
                      type: 'message',
                      thinkingBudget: event.thinkingBudget,
                      reasoningText: event.reasoningText,
                      // Sender attribution for realtime user messages (Slack /
                      // other webapp viewers / REST API), so the bubble renders
                      // the sender name without a page reload.
                      ...(event.role === 'user' && event.senderDisplayName
                        ? { userSenderDisplayName: event.senderDisplayName }
                        : {}),
                      ...(event.role === 'user' && event.senderType ? { userSenderType: event.senderType } : {}),
                      ...(event.role === 'user' && event.senderUserId ? { userSenderUserId: event.senderUserId } : {}),
                      // Carry the rebroadcast's clientId onto the new bubble
                      // so a stray re-delivery of the same event (websocket
                      // retry, listener double-fire) still dedups correctly
                      // against the bubble we just added.
                      ...(event.role === 'user' && event.clientId ? { clientId: event.clientId } : {}),
                      ...(event.imageKeys && event.imageKeys.length > 0 ? { imageKeys: event.imageKeys } : {}),
                      ...(event.fileKeys && event.fileKeys.length > 0 ? { fileKeys: event.fileKeys } : {}),
                    },
                  ];
                });
              }
            }
            break;
          case 'instanceStatusChanged':
            setInstanceStatus(event.status);
            break;
          case 'agentStatusUpdate':
            setAgentStatus(event.status);
            break;
          case 'eventTriggerFired':
            setMessages((prev) => {
              const msgId = event.id ? `${event.id}-0` : Date.now().toString();
              if (prev.some((m) => m.id === msgId)) return prev;
              return [
                ...prev,
                {
                  id: msgId,
                  role: 'assistant',
                  content: event.message,
                  detail: event.name,
                  timestamp: new Date(event.timestamp),
                  type: 'eventTrigger',
                },
              ];
            });
            break;
          case 'sessionTitleUpdate':
            setSessionTitle(event.newTitle);
            break;
          case 'toolResult':
            setMessages((prev) => {
              const toolUse = prev.findLast((msg) => msg.type == 'toolUse');
              if (toolUse && toolUse.output == undefined) {
                toolUse.output = event.output;
              }
              return prev;
            });

            // Check if the tool was todoInit or todoUpdate and refetch the todo list
            if (['todoInit', 'todoUpdate'].includes(event.toolName)) {
              refetchTodoList({ workerId });
            }
            break;
          case 'toolUse':
            if (['sendMessageToUser', 'sendMessageToUserIfNecessary'].includes(event.toolName)) {
              const message = JSON.parse(event.input).message;
              const cleanedMessage = formatMessage(message);

              // Only add message if it's not empty after removing mentions
              if (cleanedMessage) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: Date.now().toString(),
                    role: 'assistant',
                    content: cleanedMessage,
                    timestamp: new Date(event.timestamp),
                    type: 'message',
                    thinkingBudget: event.thinkingBudget,
                    reasoningText: event.reasoningText,
                  },
                ]);
              }
            } else if (['sendMessageToAgent', 'acknowledgeAgent', 'confirmSendToUser'].includes(event.toolName)) {
              // Agent-to-agent tools are silent in local view; shown via agentMessage events on parent
            } else {
              setMessages((prev) => [
                ...prev,
                {
                  id: Date.now().toString(),
                  role: 'assistant',
                  content: event.toolName,
                  detail: `${event.toolName}\n${JSON.stringify(JSON.parse(event.input), undefined, 2)}`,
                  timestamp: new Date(event.timestamp),
                  type: 'toolUse',
                  thinkingBudget: event.thinkingBudget,
                },
              ]);
            }

            // Pre-fetch todoList when todoInit or todoUpdate tool is used
            if (['todoInit', 'todoUpdate'].includes(event.toolName)) {
              refetchTodoList({ workerId });
            }

            break;
          case 'agentMessage':
            setMessages((prev) => [
              ...prev,
              {
                id: `agent-msg-${event.timestamp}`,
                role: 'user',
                content: event.message,
                timestamp: new Date(event.timestamp),
                type: 'agentMessage',
                senderSessionId: event.senderSessionId,
                senderAgentName: event.senderName,
                targetSessionId: event.targetSessionId,
                targetAgentName: event.targetName,
                isAcknowledge: event.acknowledge,
              },
            ]);
            break;
          case 'lastMessageUpdate': {
            // `lastMessageUpdate` is emitted on a separate path from the
            // bubble-drawing events (`message` / `toolUse`). AppSync
            // Events has no replay, so if a drawing event was dropped
            // while the socket was briefly down, this update can still
            // arrive while the corresponding bubble is missing. When the
            // preview text has no match on screen, self-recover with a
            // full RSC refresh — crucially this works even on a hidden
            // tab, unlike the focus/visibility-gated recovery paths.
            if (event.workerId !== workerId) break;
            const preview = event.lastMessage;
            if (!preview || isPreviewRendered(messagesRef.current, preview)) break;
            // Debounce before acting: the drawing event may simply be
            // in-flight and arrive a beat later (normal ordering race).
            // Re-check after a short grace window and cancel if it shows
            // up, so the happy path never triggers a wasted refresh.
            if (consistencyTimerRef.current) {
              clearTimeout(consistencyTimerRef.current);
            }
            const runConsistencyCheck = () => {
              consistencyTimerRef.current = null;
              if (isPreviewRendered(messagesRef.current, preview)) return;
              // Same-preview suppression: we already refreshed for this
              // exact preview, so the bubble is either in the incoming
              // snapshot or genuinely gone; either way stop here.
              if (recoveredPreviewRef.current === preview) return;
              const now = Date.now();
              const sinceLast = now - lastConsistencyRefreshAtRef.current;
              if (sinceLast < CONSISTENCY_REFRESH_MIN_INTERVAL_MS) {
                // Throttled by a very recent refresh (e.g. a preceding
                // preview's refresh). Do NOT drop the recovery — a
                // `lastMessageUpdate` fires only once per message, so a
                // silent return would lose this message forever. Re-arm for
                // the remaining throttle window and re-check then.
                consistencyTimerRef.current = setTimeout(
                  runConsistencyCheck,
                  CONSISTENCY_REFRESH_MIN_INTERVAL_MS - sinceLast
                );
                return;
              }
              lastConsistencyRefreshAtRef.current = now;
              recoveredPreviewRef.current = preview;
              router.refresh();
            };
            consistencyTimerRef.current = setTimeout(runConsistencyCheck, CONSISTENCY_REFRESH_DEBOUNCE_MS);
            break;
          }
          case 'unreadUpdate':
            // Focus-side safety net for the case where the
            // `lastMessageUpdate` above was ALSO lost in the same socket
            // disruption. The server emits `unreadUpdate(count > 0)` on
            // EVERY delivery, which almost always beats the client's async
            // mark-as-read round-trip — so a positive count on its own is
            // NOT proof of a miss and must not force a throttle bypass on
            // every focus. Instead:
            //   - count > 0 while hidden: tentatively raise the signal.
            //   - count === 0 (the echo of a completed mark-as-read):
            //     clear it. In the happy path the drawing event WAS
            //     received, mark-as-read runs, and this echo cancels the
            //     tentative raise. In a real miss the drawing event never
            //     arrived, mark-as-read never runs, no count===0 echo
            //     follows, and the raise survives to the next focus.
            if (event.userId === userId) {
              if (event.unreadCount === 0) {
                clearMissedEvents();
              } else if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
                raiseMissedEvents();
              }
            }
            break;
        }
      },
      [refetchTodoList]
    ),
  });

  const onSendMessage = async (message: MessageView) => {
    setMessages((prev) => [...prev, message]);
  };

  const onConfirmMessage = useCallback((pendingId: string, confirmedId: string) => {
    setMessages((prev) =>
      prev.map((msg) => (msg.id === pendingId ? { ...msg, id: confirmedId, pending: false } : msg))
    );
  }, []);

  const onRollbackMessage = useCallback((pendingId: string) => {
    setMessages((prev) => prev.filter((msg) => msg.id !== pendingId));
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottom = () => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  const { execute: executeUpdateStatus, isExecuting: isUpdatingStatus } = useAction(updateAgentStatus, {
    onSuccess: ({ input }) => {
      setAgentStatus(input.status);
      if (input.status === 'completed') {
        setInstanceStatus('stopped');
      }
      router.refresh();
    },
    onError: (error) => {
      toast.error(`Failed to update session status: ${error}`);
    },
  });

  const { execute: executeStopSession } = useAction(stopSession, {
    onSuccess: () => {
      setInstanceStatus('stopped');
      toast.success(t('stopSessionSuccess'));
      router.refresh();
    },
    onError: (error) => {
      toast.error(t('stopSessionError'));
    },
  });

  const { execute: executeHandover, isExecuting: isHandoverExecuting } = useAction(handoverSession, {
    onSuccess: ({ data }) => {
      setShowHandoverModal(false);
      if (data?.alreadyHandedOver) {
        toast.info(t('handoverAlreadyDone'));
      } else {
        toast.success(t('handoverSuccess'));
      }
      if (data?.workerId) {
        router.push(`/sessions/${data.workerId}`);
      }
    },
    onError: (error) => {
      const detail = error?.error?.serverError;
      toast.error(detail ? `${t('handoverError')}: ${detail}` : t('handoverError'));
    },
  });

  return (
    <div className="min-h-screen flex bg-gray-50 dark:bg-gray-900">
      {/* Sidebar */}
      <SessionSidebar
        currentWorkerId={workerId}
        sessions={allSessions}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        unreadMap={currentUnreadMap}
        userId={userId}
        onUnreadUpdate={useCallback((eventWorkerId: string, data: { unreadCount: number; hasPending: boolean }) => {
          setCurrentUnreadMap((prev) => ({
            ...prev,
            [eventWorkerId]: data,
          }));
        }, [])}
        onMarkAllRead={useCallback(() => executeMarkAllRead({}), [executeMarkAllRead])}
        isMarkingAllRead={isMarkingAllRead}
      />

      {/* Main content */}
      <div className="flex-1 min-h-screen flex flex-col min-w-0">
        <div className={`sticky z-10 transition-all duration-300 ${isHeaderVisible ? 'top-16' : 'top-0'}`}>
          <Header hasCustomIcon={!!preferences.defaultAgentIconKey} hasSidebar />
          <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 sm:px-4 sm:py-2">
            <div className="max-w-4xl mx-auto flex items-center justify-between min-w-0">
              <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-shrink">
                {/* Sidebar toggle (hamburger on mobile, hidden on lg) */}
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="relative inline-flex items-center p-1 rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer lg:hidden"
                  title={t('toggleSidebar')}
                >
                  <Menu className="w-5 h-5" />
                  {(() => {
                    const total = computeTotalUnread(Object.values(currentUnreadMap));
                    if (total <= 0) return null;
                    return (
                      <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                        {total > 99 ? '99+' : total}
                      </span>
                    );
                  })()}
                </button>
                <h1 className="text-base sm:text-lg font-medium sm:font-semibold text-gray-900 dark:text-white truncate min-w-0">
                  {sessionTitle || workerId}
                </h1>
              </div>
              <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
                {/* Status badge as dropdown */}
                {(instanceStatus || agentStatus) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-xs sm:text-sm font-medium cursor-pointer transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
                        {isUpdatingStatus ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <span
                            className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${getSessionStatus().color}`}
                          />
                        )}
                        <span className="truncate">{getSessionStatus().text}</span>
                        <ChevronDown className="w-3 h-3 text-gray-400" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem
                        onClick={() =>
                          executeUpdateStatus({
                            workerId,
                            status: agentStatus === 'completed' ? 'pending' : 'completed',
                          })
                        }
                        className="cursor-pointer"
                      >
                        {agentStatus === 'completed' ? (
                          <>
                            <Circle className="w-4 h-4 mr-2" />
                            {t('markAsIncomplete')}
                          </>
                        ) : (
                          <>
                            <Check className="w-4 h-4 mr-2" />
                            {t('markAsCompleted')}
                          </>
                        )}
                      </DropdownMenuItem>
                      {instanceStatus !== 'stopped' && agentStatus !== 'completed' && (
                        <DropdownMenuItem onClick={() => executeStopSession({ workerId })} className="cursor-pointer">
                          <Square className="w-4 h-4 mr-2" />
                          {t('stopSession')}
                        </DropdownMenuItem>
                      )}
                      {agentStatus !== 'completed' && (
                        <DropdownMenuItem onClick={() => setShowHandoverModal(true)} className="cursor-pointer">
                          <ArrowRightLeft className="w-4 h-4 mr-2" />
                          {t('handoverSession')}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {todoList && (
                  <button
                    onClick={() => setShowTodoModal(!showTodoModal)}
                    className="inline-flex items-center px-2 py-1.5 sm:px-3 sm:py-2 h-8 sm:h-10 border border-gray-300 text-xs sm:text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 dark:text-gray-200 dark:bg-gray-700 dark:border-gray-600 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 cursor-pointer"
                    title={showTodoModal ? t('hideTodoList') : t('showTodoList')}
                  >
                    <ListChecks className="h-3.5 w-3.5 sm:h-4 sm:w-4 sm:mr-2" />
                    <span className="hidden sm:inline truncate">
                      {t('todoList')} ({todoList.items.filter((item) => item.status === 'completed').length}/
                      {todoList.items.length})
                    </span>
                    <span className="inline sm:hidden truncate">
                      ({todoList.items.filter((item) => item.status === 'completed').length}/{todoList.items.length})
                    </span>
                  </button>
                )}
                <Link
                  href="/sessions/new"
                  className="inline-flex items-center px-3 py-1.5 sm:px-4 sm:py-2 h-8 sm:h-10 border border-transparent text-xs sm:text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  <Plus className="h-3.5 w-3.5 sm:h-4 sm:w-4 sm:mr-2" />
                  <span className="hidden sm:inline truncate">{t('newSession')}</span>
                </Link>
              </div>
            </div>
          </div>
        </div>

        <main className="flex-grow flex flex-col relative pt-18">
          {/* Session Content Search */}
          <SessionContentSearch workerId={workerId} />

          {/* Todo List Popup */}
          {todoList && showTodoModal && (
            <div className="fixed top-32 right-6 z-50 max-w-sm w-full animate-in slide-in-from-right-5 duration-200">
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden border border-gray-200 dark:border-gray-700 backdrop-blur-sm">
                <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {t('todoList')} ({todoList.items.filter((item) => item.status === 'completed').length}/
                    {todoList.items.length})
                  </h2>
                  <button
                    onClick={() => setShowTodoModal(false)}
                    className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 cursor-pointer p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    ✕
                  </button>
                </div>
                <div className="p-4 max-h-[70vh] overflow-y-auto">
                  <TodoList todoList={todoList} isRefreshing={isRefetchingTodoList} />
                </div>
              </div>
            </div>
          )}

          <HandoverModal
            isOpen={showHandoverModal}
            isExecuting={isHandoverExecuting}
            onClose={() => setShowHandoverModal(false)}
            onConfirm={() => executeHandover({ workerId })}
          />

          {rewindHiddenCount > 0 && (
            <div className="max-w-4xl mx-auto px-4 py-2">
              <div className="flex items-center justify-between gap-3 py-2 px-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
                <span className="text-sm text-amber-700 dark:text-amber-300">
                  {t('messagesHidden', { count: rewindHiddenCount })}
                </span>
                <button
                  onClick={handleUndoRewind}
                  className="text-sm font-medium text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 underline cursor-pointer"
                >
                  {t('undoRewind')}
                </button>
              </div>
            </div>
          )}

          <MessageList
            messages={messages}
            instanceStatus={instanceStatus}
            agentStatus={agentStatus}
            onInterrupt={handleInterrupt}
            agentIconUrl={agentIconUrl}
            agentName={agentName}
            lastReadAt={lastReadAt}
            onRewind={handleRewind}
          />

          <MessageForm
            onSubmit={onSendMessage}
            onConfirm={onConfirmMessage}
            onRollback={onRollbackMessage}
            workerId={workerId}
            currentUserDisplayName={currentUserDisplayName}
            currentUserId={userId}
            // For Kiro sessions, do NOT seed the Bedrock model selector from
            // message history: Kiro sessions can carry non-Bedrock
            // `modelOverride` values on their messages that would fail the
            // strict `ModelType` zod schema on the client and permanently
            // disable the submit button. The Kiro branch of the form uses its
            // own `kiroModelOverride` selector instead, so seeding
            // `defaultModelOverride` from preferences here is purely
            // defensive and never user-visible on Kiro sessions.
            defaultModelOverride={
              inferenceMode === 'kiro-cli'
                ? preferences.modelOverride
                : (messages.findLast((m) => m.modelOverride)?.modelOverride ?? preferences.modelOverride)
            }
            inferenceMode={inferenceMode}
            kiroModel={kiroModel}
          />

          {/* Scroll buttons - hidden when scrolled to bottom */}
          <div
            className={`fixed bottom-24 right-6 flex flex-col gap-2 z-10 transition-opacity duration-300 ${
              isBottom ? 'opacity-0 pointer-events-none' : 'opacity-100'
            }`}
          >
            <button
              onClick={scrollToTop}
              className="p-2 bg-blue-600 text-white rounded-full shadow-md hover:bg-blue-700 focus:outline-none cursor-pointer"
              title={t('scrollToTop')}
              aria-label={t('scrollToTop')}
            >
              <ArrowLeft className="w-5 h-5 rotate-90" />
            </button>
            <button
              onClick={scrollToBottom}
              className="p-2 bg-blue-600 text-white rounded-full shadow-md hover:bg-blue-700 focus:outline-none cursor-pointer"
              title={t('scrollToBottom')}
              aria-label={t('scrollToBottom')}
            >
              <ArrowLeft className="w-5 h-5 -rotate-90" />
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
