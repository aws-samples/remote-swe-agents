'use client';

import { useState } from 'react';
import Header from '@/components/Header';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEventBus } from '@/hooks/use-event-bus';
import MessageForm from './MessageForm';
import MessageList, { Message } from './MessageList';
import { webappEventSchema } from '@remote-swe-agents/agent-core/schema';

interface SessionPageClientProps {
  workerId: string;
  initialMessages: Message[];
}

export default function SessionPageClient({ workerId, initialMessages }: SessionPageClientProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [isAgentTyping, setIsAgentTyping] = useState(false);

  // Real-time communication via event bus
  useEventBus({
    channelName: `webapp/worker/${workerId}`,
    onReceived: (payload: unknown) => {
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
        case 'toolResult':
          break;
        case 'toolUse':
          if (event.toolName === 'sendMessageToUser') {
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
                timestamp: new Date(event.timestamp),
                type: 'toolUse',
              },
            ]);
          }
          setIsAgentTyping(true);
          break;
      }
    },
  });

  const onSendMessage = async (message: Message) => {
    setMessages((prev) => [...prev, message]);
    setIsAgentTyping(true);
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow flex flex-col">
        <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
          <div className="max-w-4xl mx-auto flex items-center gap-4">
            <Link
              href="/sessions"
              className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
            >
              <ArrowLeft className="w-4 h-4" />
              Session List
            </Link>
            <div className="flex-1">
              <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Session: {workerId}</h1>
              <p className="text-sm text-gray-600 dark:text-gray-300">Chat with AI Agent</p>
            </div>
          </div>
        </div>

        <MessageList messages={messages} isAgentTyping={isAgentTyping} />

        <MessageForm onSubmit={onSendMessage} workerId={workerId} />
      </main>
    </div>
  );
}
