'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/Header';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEventBus } from '@/hooks/use-event-bus';
import MessageForm from './MessageForm';
import MessageList, { Message } from './MessageList';
import { webappEventSchema } from '@remote-swe-agents/agent-core/schema';
import { useTranslations } from 'next-intl';
import { useScrollPosition } from '@/hooks/use-scroll-position';

interface SessionPageClientProps {
  workerId: string;
  initialMessages: Message[];
  initialInstanceStatus?: 'starting' | 'running' | 'stopped' | 'terminated';
}

export default function SessionPageClient({
  workerId,
  initialMessages,
  initialInstanceStatus,
}: SessionPageClientProps) {
  const t = useTranslations('sessions');
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [instanceStatus, setInstanceStatus] = useState<'starting' | 'running' | 'stopped' | 'terminated' | undefined>(
    initialInstanceStatus
  );

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

  const onSendMessage = async (message: Message) => {
    setMessages((prev) => [...prev, message]);
    setIsAgentTyping(true);
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottom = () => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

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
                {t('sessionList')}
              </Link>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Session: {workerId}</h1>
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
            <Link
              href="/sessions/new"
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              {t('newSession')}
            </Link>
          </div>
        </div>
      </div>

      <main className="flex-grow flex flex-col relative">
        <MessageList messages={messages} isAgentTyping={isAgentTyping} instanceStatus={instanceStatus} />

        <MessageForm onSubmit={onSendMessage} workerId={workerId} />

        {/* Scroll buttons */}
        <div className="fixed bottom-24 right-6 flex flex-col gap-2 z-10">
          <button
            onClick={scrollToTop}
            className="p-2 bg-blue-600 text-white rounded-full shadow-md hover:bg-blue-700 focus:outline-none"
            title={t('scrollToTop')}
            aria-label={t('scrollToTop')}
          >
            <ArrowLeft className="w-5 h-5 rotate-90" />
          </button>
          <button
            onClick={scrollToBottom}
            className="p-2 bg-blue-600 text-white rounded-full shadow-md hover:bg-blue-700 focus:outline-none"
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
