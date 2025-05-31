'use client';

import { useState } from 'react';
import Header from '@/components/Header';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEventBus } from '@/hooks/use-event-bus';
import MessageForm from './MessageForm';
import MessageList from './MessageList';

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  type?: 'message' | 'progress' | 'tool_use';
}

interface AgentEvent {
  type: 'message' | 'progress' | 'tool_use';
  payload:
    | {
        content?: string;
        message?: string;
      }
    | string;
  timestamp?: string;
}

interface SessionPageClientProps {
  workerId: string;
  initialMessages: AgentMessage[];
}

export default function SessionPageClient({ workerId, initialMessages }: SessionPageClientProps) {
  const [messages, setMessages] = useState<AgentMessage[]>(initialMessages);
  const [isAgentTyping, setIsAgentTyping] = useState(false);

  // Real-time communication via event bus
  useEventBus({
    channelName: `webapp/worker/${workerId}`,
    onReceived: (payload: unknown) => {
      const event = payload as AgentEvent;
      console.log('Received event:', event);

      switch (event.type) {
        case 'message':
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: 'assistant',
              content: typeof event.payload === 'string' ? event.payload : event.payload.content || '',
              timestamp: event.timestamp || new Date().toISOString(),
              type: 'message',
            },
          ]);
          setIsAgentTyping(false);
          break;
        case 'progress':
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: 'assistant',
              content: `🔄 ${typeof event.payload === 'string' ? event.payload : event.payload.message || ''}`,
              timestamp: event.timestamp || new Date().toISOString(),
              type: 'progress',
            },
          ]);
          break;
        case 'tool_use':
          setIsAgentTyping(true);
          break;
      }
    },
  });

  // Send message
  const sendMessage = async (message?: string) => {
    // setMessages((prev) => [...prev, userMessage]);

    try {
      console.log('Message sent successfully');
    } catch (error) {
      console.error('Failed to send message:', error);
      setIsAgentTyping(false);
      // Display error message
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: 'Failed to send message. Please try again.',
          timestamp: new Date().toISOString(),
          type: 'message',
        },
      ]);
    }
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

        <MessageForm onSubmit={sendMessage} workerId={workerId} />
      </main>
    </div>
  );
}
