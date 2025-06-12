'use client';

import { useState, useCallback } from 'react';
import Header from '@/components/Header';
import { ArrowLeft, ListChecks, Check, Plus, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useAction } from 'next-safe-action/hooks';
import { updateAgentStatus } from '../actions';
import { useEventBus } from '@/hooks/use-event-bus';
import MessageForm from './MessageForm';
import MessageList, { MessageView } from './MessageList';
import {
  webappEventSchema,
  TodoList as TodoListType,
  AgentStatus,
  InstanceStatus,
} from '@remote-swe-agents/agent-core/schema';
import { useTranslations } from 'next-intl';
import TodoList from './TodoList';
import { fetchLatestTodoList } from '../actions';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { formatMessage } from '@/lib/message-formatter';

interface SessionPageClientProps {
  workerId: string;
  initialMessages: MessageView[];
  initialInstanceStatus?: InstanceStatus;
  initialAgentStatus?: AgentStatus;
  initialTodoList: TodoListType | null;
}

export default function SessionPageClient({
  workerId,
  initialMessages,
  initialInstanceStatus,
  initialAgentStatus,
  initialTodoList,
}: SessionPageClientProps) {
  const t = useTranslations('sessions');
  const router = useRouter();
  const [messages, setMessages] = useState<MessageView[]>(initialMessages);
  const [instanceStatus, setInstanceStatus] = useState<InstanceStatus | undefined>(initialInstanceStatus);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | undefined>(initialAgentStatus);
  const [todoList, setTodoList] = useState<TodoListType | null>(initialTodoList);
  const [showTodoModal, setShowTodoModal] = useState(false);

  const getUnifiedStatus = () => {
    if (agentStatus === 'completed') {
      return { text: t('agentStatus.completed'), color: 'bg-gray-500' };
    }
    if (instanceStatus === 'stopped' || instanceStatus === 'terminated') {
      return { text: t('sessionStatus.stopped'), color: 'bg-gray-500' };
    }
    if (instanceStatus === 'starting') {
      return { text: t('sessionStatus.starting'), color: 'bg-blue-500' };
    }
    if (agentStatus === 'pending') {
      return { text: t('agentStatus.pending'), color: 'bg-yellow-500' };
    }
    if (agentStatus === 'working') {
      return { text: t('agentStatus.working'), color: 'bg-green-500' };
    }
    return { text: t('agentStatus.unknown'), color: 'bg-gray-400' };
  };

  // Refetch todoList function using safe action
  const { execute: refetchTodoList, isExecuting: isRefetchingTodoList } = useAction(fetchLatestTodoList, {
    onSuccess: ({ data }) => {
      if (data?.todoList) {
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

        switch (event.type) {
          case 'message':
            if (event.message) {
              const cleanedMessage = formatMessage(event.message);
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
                  },
                ]);
              }
            }
            break;
          case 'instanceStatusChanged':
            setInstanceStatus(event.status);
            break;
          case 'agentStatusUpdate':
            setAgentStatus(event.status);
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
                  },
                ]);
              }
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
                },
              ]);
            }

            // Pre-fetch todoList when todoInit or todoUpdate tool is used
            if (['todoInit', 'todoUpdate'].includes(event.toolName)) {
              refetchTodoList({ workerId });
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

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottom = () => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  const { execute: executeUpdateStatus, isExecuting: isUpdatingStatus } = useAction(updateAgentStatus, {
    onSuccess: ({ input }) => {
      setAgentStatus(input.status);
      router.refresh();
    },
    onError: (error) => {
      toast.error(`Failed to update session status: ${error}`);
    },
  });

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <div className="sticky top-0 z-10">
        <Header />
        <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
          <div className="max-w-4xl mx-auto flex items-center justify-between min-w-0">
            <div className="flex items-center gap-4 min-w-0 flex-shrink">
              <Link
                href="/sessions"
                className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white flex-shrink-0"
              >
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline truncate">{t('sessionList')}</span>
              </Link>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-white hidden sm:block truncate min-w-0">
                {workerId}
              </h1>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Session status toggle button */}
              <button
                onClick={() =>
                  executeUpdateStatus({
                    workerId,
                    status: agentStatus === 'completed' ? 'pending' : 'completed',
                  })
                }
                className={`flex items-center justify-center w-6 h-6 border-2 rounded cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
                  agentStatus === 'completed'
                    ? 'border-gray-400 bg-gray-400 dark:border-gray-500 dark:bg-gray-500'
                    : 'border-gray-300 bg-white hover:border-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-gray-500'
                }`}
                title={agentStatus === 'completed' ? t('markAsIncomplete') : t('markAsCompleted')}
                disabled={isUpdatingStatus}
              >
                {isUpdatingStatus ? (
                  <Loader2 className="h-3 w-3 animate-spin text-gray-600 dark:text-gray-300" />
                ) : (
                  agentStatus === 'completed' && <Check className="h-4 w-4 text-white" />
                )}
              </button>
              {(instanceStatus || agentStatus) && (
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${getUnifiedStatus().color}`} />
                  <span className="text-sm font-medium truncate min-w-0">{getUnifiedStatus().text}</span>
                </div>
              )}
              {todoList && (
                <button
                  onClick={() => setShowTodoModal(!showTodoModal)}
                  className="inline-flex items-center px-3 py-2 h-10 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 dark:text-gray-200 dark:bg-gray-700 dark:border-gray-600 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 cursor-pointer"
                  title={showTodoModal ? t('hideTodoList') : t('showTodoList')}
                >
                  <ListChecks className="h-4 w-4 sm:mr-2" />
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
                className="inline-flex items-center px-4 py-2 h-10 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <Plus className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline truncate">{t('newSession')}</span>
              </Link>
            </div>
          </div>
        </div>
      </div>

      <main className="flex-grow flex flex-col relative">
        {/* Todo List Popup */}
        {todoList && showTodoModal && (
          <div className="fixed top-30 right-4 z-50 max-w-sm w-full">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl overflow-y-auto border border-gray-200 dark:border-gray-700">
              <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
                <h2 className="text-md font-medium">
                  {t('todoList')} ({todoList.items.filter((item) => item.status === 'completed').length}/
                  {todoList.items.length})
                </h2>
                <button
                  onClick={() => setShowTodoModal(false)}
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 cursor-pointer"
                >
                  ✕
                </button>
              </div>
              <div className="p-3 max-h-[70vh] overflow-y-auto">
                <TodoList todoList={todoList} isRefreshing={isRefetchingTodoList} />
              </div>
            </div>
          </div>
        )}

        <MessageList messages={messages} instanceStatus={instanceStatus} agentStatus={agentStatus} />

        <MessageForm onSubmit={onSendMessage} workerId={workerId} />

        {/* Scroll buttons */}
        <div className="fixed bottom-24 right-6 flex flex-col gap-2 z-10">
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
  );
}
