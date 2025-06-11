'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/Header';
import { ArrowLeft, ListChecks, CheckCircle, Plus } from 'lucide-react';
import Link from 'next/link';
import { useAction } from 'next-safe-action/hooks';
import { updateAgentStatus } from '../actions';
import { useEventBus } from '@/hooks/use-event-bus';
import MessageForm from './MessageForm';
import MessageList, { MessageView } from './MessageList';
import { webappEventSchema, TodoList as TodoListType, AgentStatus } from '@remote-swe-agents/agent-core/schema';
import { useTranslations } from 'next-intl';
import TodoList from './TodoList';
import { toast } from 'sonner';

interface SessionPageClientProps {
  workerId: string;
  initialMessages: MessageView[];
  initialInstanceStatus?: 'starting' | 'running' | 'stopped' | 'terminated';
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
  const [messages, setMessages] = useState<MessageView[]>(initialMessages);
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [instanceStatus, setInstanceStatus] = useState<'starting' | 'running' | 'stopped' | 'terminated' | undefined>(
    initialInstanceStatus
  );
  const [agentStatus, setAgentStatus] = useState<AgentStatus | undefined>(initialAgentStatus);
  const [todoList, setTodoList] = useState<TodoListType | null>(initialTodoList);
  const [showTodoModal, setShowTodoModal] = useState(false);

  // Real-time communication via event bus
  useEventBus({
    channelName: `webapp/worker/${workerId}`,
    onReceived: useCallback((payload: unknown) => {
      console.log('Received event:', payload);
      const event = webappEventSchema.parse(payload);

      switch (event.type) {
        case 'message':
          if (event.message) {
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now().toString(),
                role: 'assistant',
                content: event.message,
                timestamp: new Date(event.timestamp),
                type: 'message',
              },
            ]);
          }
          setIsAgentTyping(false);
          break;
        case 'instanceStatusChanged':
          setInstanceStatus(event.status);
          break;
        case 'toolResult':
          setMessages((prev) => {
            const toolUse = prev.findLast((msg) => msg.type == 'toolUse');
            if (toolUse && toolUse.output == undefined) {
              toolUse.output = event.output;
            }
            return prev;
          });
          break;
        case 'toolUse':
          if (['sendMessageToUser', 'sendMessageToUserIfNecessary'].includes(event.toolName)) {
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now().toString(),
                role: 'assistant',
                content: JSON.parse(event.input).message,
                timestamp: new Date(event.timestamp),
                type: 'message',
              },
            ]);
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
          setIsAgentTyping(true);
          break;
      }
    }, []),
  });

  const onSendMessage = async (message: MessageView) => {
    setMessages((prev) => [...prev, message]);
    setIsAgentTyping(true);
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottom = () => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  const { execute: executeUpdateStatus } = useAction(updateAgentStatus, {
    onSuccess: () => {
      setAgentStatus('completed');
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
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link
                href="/sessions"
                className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
              >
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline">{t('sessionList')}</span>
              </Link>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-white">{workerId}</h1>
              {instanceStatus && (
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${
                      instanceStatus === 'running'
                        ? 'bg-green-500'
                        : instanceStatus === 'starting'
                          ? 'bg-blue-500'
                          : 'bg-gray-500'
                    }`}
                  />
                  <span className="text-sm font-medium">
                    {instanceStatus === 'running'
                      ? t('instanceRunning')
                      : instanceStatus === 'starting'
                        ? t('instanceStarting')
                        : t('instanceStopped')}
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {todoList && (
                <button
                  onClick={() => setShowTodoModal(!showTodoModal)}
                  className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 dark:text-gray-200 dark:bg-gray-700 dark:border-gray-600 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 cursor-pointer"
                  title={showTodoModal ? t('hideTodoList') : t('showTodoList')}
                >
                  <ListChecks className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">
                    {t('todoList')} ({todoList.items.filter((item) => item.status === 'completed').length}/
                    {todoList.items.length})
                  </span>
                  <span className="inline sm:hidden">
                    ({todoList.items.filter((item) => item.status === 'completed').length}/{todoList.items.length})
                  </span>
                </button>
              )}
              <Link
                href="/sessions/new"
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                <Plus className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">{t('newSession')}</span>
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
                <TodoList todoList={todoList} />
              </div>
            </div>
          </div>
        )}

        <MessageList messages={messages} isAgentTyping={isAgentTyping} instanceStatus={instanceStatus} />

        <MessageForm onSubmit={onSendMessage} workerId={workerId} />

        {/* Scroll buttons and actions */}
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
          {/* Mark as completed button - only show if not already completed */}
          {agentStatus !== 'completed' && (
            <button
              onClick={() =>
                executeUpdateStatus({
                  workerId,
                  status: 'completed',
                })
              }
              className="p-2 bg-green-600 text-white rounded-full shadow-md hover:bg-green-700 focus:outline-none cursor-pointer"
              title={t('markAsCompleted')}
              aria-label={t('markAsCompleted')}
            >
              <CheckCircle className="w-5 h-5" />
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
