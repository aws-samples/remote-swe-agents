'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import Header from '@/components/Header';
import { ListChecks, Check, Circle, Loader2, Menu, ChevronDown, Square, ArrowRightLeft } from 'lucide-react';
import { useScrollPosition } from '@/hooks/use-scroll-position';
import { useViewportState } from '@/hooks/use-viewport-state';
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
import { computeTotalUnread } from '@/lib/unread-display';
import { useEventBus } from '@/hooks/use-event-bus';
import { toolNameInSet } from '@remote-swe-agents/agent-core/tool-name-utils';
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
  InferenceMode,
  ModelType,
} from '@remote-swe-agents/agent-core/schema';
import type { SessionListItem } from '@/lib/session-list';
import { parseAttachmentSentinel } from '@remote-swe-agents/agent-core/attachments';
import { useTranslations } from 'next-intl';
import TodoList from './TodoList';
import { getUnifiedStatus } from '@/utils/session-status';
import { fetchLatestTodoList } from '../actions';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { formatMessage } from '@/lib/message-formatter';
import { mergeDuplicateUserRebroadcast } from './dedup';
import HandoverModal from './HandoverModal';
import SessionSidebar from './SessionSidebar';
import SessionContentSearch from './SessionContentSearch';
import { ArrowLeft } from 'lucide-react';
import { useSwipeGesture } from '@/hooks/use-swipe-gesture';
import { PortMappingProvider, usePortMappingSetter } from './PortMappingContext';
import type { PortMapping } from '@/lib/port-url-transform';
import { isPreviewRendered } from './message-consistency';
import { raiseMissedEvents, clearMissedEvents } from '@/lib/missed-events-signal';

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

const SEND_MSG_TOOLS = new Set([
  'sendMessageToUser',
  'sendMessageToUserIfNecessary',
  'Send Message To User',
  'Send_Message_To_User',
]);
const SEND_FILE_TOOLS = new Set(['sendFileToUser', 'Send File To User']);
const TODO_TOOLS = new Set(['todoInit', 'todoUpdate', 'Todo Init', 'Todo Update']);

interface SessionPageClientProps {
  workerId: string;
  userId: string;
  /**
   * Display name of the currently signed-in user. Forwarded to
   * `MessageForm` so the client-side optimistic bubble the submitter sees
   * is labelled with their own name instead of the generic "User" — the
   * server rebroadcast carries the same field and the dedupe path in
   * `case 'message'` short-circuits so we never render it twice.
   */
  currentUserDisplayName?: string;
  preferences: GlobalPreferences;
  initialTitle: string | undefined;
  initialMessages: MessageView[];
  initialInstanceStatus?: InstanceStatus;
  initialAgentStatus?: AgentStatus;
  initialTodoList: TodoListType | null;
  allSessions: SessionListItem[];
  agentIconUrl?: string;
  agentName?: string;
  unreadMap?: Record<string, { unreadCount: number; hasPending: boolean }>;
  lastReadAt?: number;
  childSessions?: { workerId: string; title?: string }[];
  parentSessionId?: string;
  /**
   * Effective inference mode for this session, resolved server-side using the
   * same priority chain as the worker (session > customAgent > userPrefs >
   * env > default). When `'kiro-cli'`, the chat input should show a read-only
   * Kiro badge instead of the Bedrock model picker.
   */
  inferenceMode?: InferenceMode;
  /**
   * Kiro model baked into the session (or inherited from user preferences for
   * legacy sessions). Only meaningful when `inferenceMode === 'kiro-cli'`.
   */
  kiroModel?: string;
  /**
   * Effective Bedrock model for this session, resolved server-side via the
   * priority chain (session > customAgent > env > default). User preferences
   * are deliberately excluded from the runtime chain for existing sessions.
   */
  bedrockModel?: ModelType;
  /**
   * Raw session.bedrockDefaultModel value (not resolved). When set, indicates
   * an explicit model selection was persisted to this session and should take
   * priority over message-history scan for the selector initial value.
   */
  sessionBedrockDefaultModel?: ModelType;
  /**
   * Opened-ports mapping (hostname + open ranges) persisted by the `openPort`
   * tool. Used to rewrite localhost:PORT references in messages to clickable
   * public preview URLs. `null` when no ports have ever been opened.
   */
  initialPortMapping?: PortMapping | null;
  initialRewindHiddenCount?: number;
}

export default function SessionPageClient({
  workerId,
  userId,
  currentUserDisplayName,
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
  bedrockModel,
  sessionBedrockDefaultModel,
  initialPortMapping,
  initialRewindHiddenCount,
}: SessionPageClientProps) {
  return (
    <PortMappingProvider initialMapping={initialPortMapping ?? null}>
      <SessionPageClientInner
        workerId={workerId}
        userId={userId}
        currentUserDisplayName={currentUserDisplayName}
        preferences={preferences}
        initialTitle={initialTitle}
        initialMessages={initialMessages}
        initialInstanceStatus={initialInstanceStatus}
        initialAgentStatus={initialAgentStatus}
        initialTodoList={initialTodoList}
        allSessions={allSessions}
        agentIconUrl={agentIconUrl}
        agentName={agentName}
        unreadMap={unreadMap}
        lastReadAt={lastReadAt}
        parentSessionId={parentSessionId}
        inferenceMode={inferenceMode}
        kiroModel={kiroModel}
        bedrockModel={bedrockModel}
        sessionBedrockDefaultModel={sessionBedrockDefaultModel}
        initialRewindHiddenCount={initialRewindHiddenCount}
      />
    </PortMappingProvider>
  );
}

function SessionPageClientInner({
  workerId,
  userId,
  currentUserDisplayName,
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
  bedrockModel,
  sessionBedrockDefaultModel,
  initialRewindHiddenCount,
}: Omit<SessionPageClientProps, 'initialPortMapping'>) {
  const setPortMapping = usePortMappingSetter();
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
  // reads the freshest bubbles without needing `messages` in the event
  // handler's dependency array (which would re-subscribe the bus).
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
  const { isDisplaced: hideScrollButtons } = useViewportState();

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

  // Mark as read on mount / when the viewed session changes. Keyed on
  // `workerId` only; `executeMarkRead` (a next-safe-action executor) is
  // intentionally omitted so a change in its identity does not re-fire the
  // mark-read.
  useEffect(() => {
    executeMarkRead({ workerId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (e.defaultPrevented) return;
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

  const handleCopyTitleAndId = useCallback(async () => {
    const text = sessionTitle ? `${sessionTitle}(${workerId})` : workerId;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copiedToClipboard'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }, [sessionTitle, workerId, t]);

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
    // AppSync Events does not replay events published while the socket was
    // down. When the connection recovers from a disruption (or while it is
    // still unhealthy), re-fetch the server snapshot: the RSC re-render
    // replaces `initialMessages` (and status/title/todo props) wholesale from
    // DynamoDB, so missed events are recovered without any risk of duplicate
    // bubbles.
    onReconnected: useCallback(() => {
      router.refresh();
    }, [router]),
    onReceived: useCallback(
      (payload: unknown) => {
        console.log('Received event:', payload);
        // Guard the whole handler: a single malformed event (or a throw
        // from e.g. `JSON.parse(event.input)` below) must not kill the
        // subscription callback and stop all future realtime updates.
        // Matches the try/catch pattern in SessionSidebar / SessionsList.
        try {
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
                // Normalize the rebroadcast payload exactly as the optimistic
                // bubble path will normalize its own content for display.
                // `formatMessage` strips Slack mentions and pads URLs. We
                // deliberately do NOT call `stripSenderPrefix` here:
                // rebroadcast events carry the raw user-typed text (no
                // `[from: ...]` envelope is ever attached server-side on
                // this path), so applying the prefix-strip would silently
                // delete a leading `[from: ...]` that the user actually
                // typed. The DDB-read path in `page.tsx` keeps the strip
                // because legacy items there may carry the LLM envelope
                // wrapping.
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
                    // to the submitter's own tab, so a drop-only dedup left the
                    // submitter unable to see their own attachments until a
                    // full server re-render (the bug this fixes).
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
                        ...(event.role === 'user' && event.senderDisplayName
                          ? { userSenderDisplayName: event.senderDisplayName }
                          : {}),
                        ...(event.role === 'user' && event.senderType ? { userSenderType: event.senderType } : {}),
                        ...(event.role === 'user' && event.senderUserId
                          ? { userSenderUserId: event.senderUserId }
                          : {}),
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
                // Immutable update: mutating the existing bubble in place and
                // returning the same array reference makes React bail out of
                // re-rendering (the previously-shipped bug where tool output
                // never appeared until a full refresh). Copy the target bubble
                // into a new array instead.
                let next = prev;
                const toolUseIdx = prev.findLastIndex((msg) => msg.type == 'toolUse');
                if (toolUseIdx >= 0 && prev[toolUseIdx].output == undefined) {
                  next = [...prev];
                  next[toolUseIdx] = { ...next[toolUseIdx], output: event.output };
                }
                if (event.imageKeys && event.imageKeys.length > 0 && toolUseIdx >= 0) {
                  const existing = new Set(next[toolUseIdx].imageKeys ?? []);
                  const deduped = event.imageKeys.filter((k: string) => !existing.has(k));
                  if (deduped.length > 0) {
                    if (next === prev) next = [...prev];
                    next[toolUseIdx] = {
                      ...next[toolUseIdx],
                      imageKeys: [...(next[toolUseIdx].imageKeys ?? []), ...deduped],
                    };
                  }
                }
                // For `sendFileToUser`, the backend embeds the uploaded S3 key
                // in the tool output as a sentinel. Find the placeholder bubble
                // we pushed on the matching `toolUse` event and attach the
                // image/file keys now that we know them.
                if (toolNameInSet(event.toolName, SEND_FILE_TOOLS)) {
                  const sentinel = parseAttachmentSentinel(event.output);
                  if (sentinel) {
                    const bubbleId = `sendFileToUser-${event.toolUseId}`;
                    const idx = next.findIndex((m) => m.id === bubbleId);
                    if (idx >= 0) {
                      if (next === prev) next = [...prev];
                      next[idx] = sentinel.isImage
                        ? { ...next[idx], imageKeys: [sentinel.key] }
                        : { ...next[idx], fileKeys: [sentinel.key] };
                    }
                  }
                }
                return next;
              });

              // Check if the tool was todoInit or todoUpdate and refetch the todo list
              if (toolNameInSet(event.toolName, TODO_TOOLS)) {
                refetchTodoList({ workerId });
              }
              break;
            case 'toolUse':
              if (toolNameInSet(event.toolName, SEND_MSG_TOOLS)) {
                const message = JSON.parse(event.input).message;
                const cleanedMessage = formatMessage(message);

                // Only add message if it's not empty after removing mentions
                if (cleanedMessage) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: event.messageSK ? `${event.messageSK}-${event.toolUseId}` : Date.now().toString(),
                      role: 'assistant',
                      content: cleanedMessage,
                      timestamp: event.messageSK ? new Date(parseInt(event.messageSK)) : new Date(event.timestamp),
                      type: 'message',
                      thinkingBudget: event.thinkingBudget,
                      reasoningText: event.reasoningText,
                    },
                  ]);
                }
              } else if (toolNameInSet(event.toolName, new Set(['sendImageToUser', 'Send Image To User']))) {
                const input = JSON.parse(event.input);
                const messageText = input.message;
                // TODO: share the same logic with backend
                const ext = '.' + input.imagePath.split('.').at(-1);
                const key = `${workerId}/${event.toolUseId}${ext}`;

                setMessages((prev) => [
                  ...prev,
                  {
                    id: event.messageSK ? `${event.messageSK}-${event.toolUseId}` : Date.now().toString(),
                    role: 'assistant',
                    content: messageText,
                    timestamp: event.messageSK ? new Date(parseInt(event.messageSK)) : new Date(event.timestamp),
                    type: 'message',
                    imageKeys: [key],
                    thinkingBudget: event.thinkingBudget,
                  },
                ]);
              } else if (toolNameInSet(event.toolName, SEND_FILE_TOOLS)) {
                const input = JSON.parse(event.input);
                const messageText = input.message;
                // Render the chat bubble immediately with just the text. The
                // backend embeds the canonical S3 key in the tool result as a
                // `<!--remote-swe-attachment:...-->` sentinel, so we wait for
                // the matching `toolResult` event below to attach image/file
                // keys. This avoids the earlier bug where the key was
                // predicted from `event.toolUseId` + filename, which broke for
                // kiro-cli sessions because the MCP server uploads under a
                // different (random) id than the ACP toolCallId.
                setMessages((prev) => [
                  ...prev,
                  {
                    id: `sendFileToUser-${event.toolUseId}`,
                    role: 'assistant',
                    content: messageText,
                    timestamp: event.messageSK ? new Date(parseInt(event.messageSK)) : new Date(event.timestamp),
                    type: 'message',
                    thinkingBudget: event.thinkingBudget,
                  },
                ]);
              } else if (
                toolNameInSet(
                  event.toolName,
                  new Set([
                    'sendMessageToAgent',
                    'acknowledgeAgent',
                    'confirmSendToUser',
                    'confirmCompleteSession',
                    'Send Message To Agent',
                    'Acknowledge Agent',
                    'Confirm Send To User',
                    'Confirm Complete Session',
                  ])
                )
              ) {
                // Agent-to-agent tools are silent in local view; shown via agentMessage events on parent
              } else {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: event.messageSK ? `${event.messageSK}-${event.toolUseId}` : Date.now().toString(),
                    role: 'assistant',
                    content: event.toolName,
                    detail: `${event.toolName}\n${JSON.stringify(JSON.parse(event.input), undefined, 2)}`,
                    timestamp: event.messageSK ? new Date(parseInt(event.messageSK)) : new Date(event.timestamp),
                    type: 'toolUse',
                    thinkingBudget: event.thinkingBudget,
                  },
                ]);
              }

              // Pre-fetch todoList when todoInit or todoUpdate tool is used
              if (toolNameInSet(event.toolName, TODO_TOOLS)) {
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
            case 'portsUpdate':
              // Refresh the port mapping so localhost:PORT rewrites reflect the
              // latest openPort/closePort invocation in real time.
              // When hostname starts with https://, it's a CloudFront preview URL
              // (from MicroVM-based preview) rather than an EC2 hostname.
              if (event.hostname?.startsWith('https://')) {
                setPortMapping({
                  previewBaseUrl: event.hostname,
                  openedPorts: event.openedPorts,
                });
              } else {
                setPortMapping({
                  hostname: event.hostname,
                  openedPorts: event.openedPorts,
                });
              }
              break;
            case 'lastMessageUpdate': {
              // `lastMessageUpdate` is emitted on a separate path from the
              // bubble-drawing events (`message` / `toolUse`). AppSync
              // Events has no replay, so if a drawing event was dropped
              // while the socket was briefly down, this update can still
              // arrive while the corresponding bubble is missing. When the
              // preview text has no match on screen, self-recover with a
              // full RSC refresh -- crucially this works even on a hidden
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
                  // preview's refresh). Do NOT drop the recovery -- a
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
            case 'agentError':
              if (event.willRetry) {
                toast.warning(t('agentErrorRetrying', { errorType: event.errorType }));
              } else {
                toast.error(t('agentErrorStopped', { errorType: event.errorType }));
              }
              break;
            case 'unreadUpdate':
              // Focus-side safety net for the case where the
              // `lastMessageUpdate` above was ALSO lost in the same socket
              // disruption. The server emits `unreadUpdate(count > 0)` on
              // EVERY delivery, which almost always beats the client's async
              // mark-as-read round-trip -- so a positive count on its own is
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
        } catch (error) {
          console.error('Failed to handle webapp event:', error);
        }
      },
      // `executeMarkRead` is intentionally omitted from the deps:
      // `useEventBus` re-subscribes the AppSync Events socket whenever
      // `onReceived` changes identity, so this callback must stay stable.
      // The mark-read executor is only invoked, never compared; the other
      // referenced values (workerId/userId/router and the two setters) are
      // included.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [refetchTodoList, setPortMapping, workerId, userId, router]
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
              <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
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
                <h1 className="text-base sm:text-lg font-medium sm:font-semibold text-gray-900 dark:text-white min-w-0 flex-1 w-full">
                  <button
                    type="button"
                    onClick={handleCopyTitleAndId}
                    title={t('copySessionId')}
                    aria-label={t('copySessionId')}
                    className="block max-w-full truncate text-left cursor-pointer rounded-md px-1 -mx-1 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
                  >
                    {sessionTitle || workerId}
                  </button>
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
                <SessionContentSearch workerId={workerId} sidebarOpen={sidebarOpen} />
              </div>
            </div>
          </div>
        </div>

        <main className="flex-grow flex flex-col relative pt-18">
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
            // message history: legacy Kiro sessions (created before Phase 2b)
            // carry non-Bedrock `modelOverride` values on their messages that
            // would fail the strict `ModelType` zod schema on the client and
            // permanently disable the submit button. The Kiro branch of the
            // form uses its own `kiroModelOverride` selector instead, so
            // seeding `defaultModelOverride` from preferences here is purely
            // defensive and never user-visible on Kiro sessions.
            defaultModelOverride={
              inferenceMode === 'kiro-cli'
                ? preferences.modelOverride
                : (sessionBedrockDefaultModel ??
                  messages.findLast((m) => m.modelOverride)?.modelOverride ??
                  bedrockModel ??
                  preferences.modelOverride)
            }
            inferenceMode={inferenceMode}
            kiroModel={kiroModel}
            agentStatus={agentStatus}
            onInterrupt={handleInterrupt}
          />

          {/* Scroll buttons - hidden when scrolled to bottom or viewport is displaced */}
          <div
            className={`fixed bottom-24 right-6 flex flex-col gap-2 z-10 transition-opacity duration-300 ${
              isBottom || hideScrollButtons ? 'opacity-0 pointer-events-none' : 'opacity-100'
            }`}
            style={{ willChange: 'transform' }}
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
