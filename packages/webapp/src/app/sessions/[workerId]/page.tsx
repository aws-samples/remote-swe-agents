'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Send, Bot, User, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEventBus } from '@/hooks/use-event-bus';
import { sendMessageToAgent } from '@/app/(root)/actions';

interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  type?: 'message' | 'progress' | 'tool_use';
}

interface AgentEvent {
  type: 'message' | 'progress' | 'tool_use';
  payload: {
    content?: string;
    message?: string;
  } | string;
  timestamp?: string;
}

export default function SessionPage() {
  const params = useParams();
  const workerId = params.workerId as string;
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Real-time communication via event bus
  useEventBus({
    channelName: `session/${workerId}`,
    onReceived: (payload: unknown) => {
      const event = payload as AgentEvent;
      console.log('Received event:', event);
      
      switch (event.type) {
        case 'message':
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'assistant',
            content: typeof event.payload === 'string' ? event.payload : (event.payload.content || ''),
            timestamp: event.timestamp || new Date().toISOString(),
            type: 'message'
          }]);
          setIsAgentTyping(false);
          break;
        case 'progress':
          setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'assistant',
            content: `🔄 ${typeof event.payload === 'string' ? event.payload : (event.payload.message || '')}`,
            timestamp: event.timestamp || new Date().toISOString(),
            type: 'progress'
          }]);
          break;
        case 'tool_use':
          setIsAgentTyping(true);
          break;
      }
    }
  });

  // Send message
  const sendMessage = async () => {
    if (!inputMessage.trim() || isSending) return;

    const userMessage: AgentMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: inputMessage,
      timestamp: new Date().toISOString()
    };

    const messageToSend = inputMessage;
    setMessages(prev => [...prev, userMessage]);
    setInputMessage('');
    setIsSending(true);
    setIsAgentTyping(true);

    try {
      const result = await sendMessageToAgent({
        workerId,
        message: messageToSend,
      });
      
      if (!result?.data?.success) {
        throw new Error('Failed to send message');
      }
      
      console.log('Message sent successfully');
    } catch (error) {
      console.error('Failed to send message:', error);
      setIsAgentTyping(false);
      // Display error message
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Failed to send message. Please try again.',
        timestamp: new Date().toISOString(),
        type: 'message'
      }]);
    } finally {
      setIsSending(false);
    }
  };

  // Auto scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Send message on Enter key
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
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

        {/* Message list */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto px-4 py-6">
            {messages.length === 0 ? (
              <div className="text-center py-12">
                <Bot className="w-12 h-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                  Let&apos;s start the conversation
                </h3>
                <p className="text-gray-600 dark:text-gray-300">
                  Send questions or requests to the AI agent using the message input below
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex gap-4 ${
                      message.role === 'user' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    {message.role === 'assistant' && (
                      <div className="flex-shrink-0">
                        <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
                          <Bot className="w-4 h-4 text-white" />
                        </div>
                      </div>
                    )}
                    
                    <div
                      className={`max-w-3xl rounded-lg px-4 py-3 ${
                        message.role === 'user'
                          ? 'bg-blue-600 text-white'
                          : message.type === 'progress'
                          ? 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'
                      }`}
                    >
                      <div className="whitespace-pre-wrap">{message.content}</div>
                      <div className={`text-xs mt-2 ${
                        message.role === 'user' ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'
                      }`}>
                        {new Date(message.timestamp).toLocaleTimeString('en-US')}
                      </div>
                    </div>

                    {message.role === 'user' && (
                      <div className="flex-shrink-0">
                        <div className="w-8 h-8 bg-gray-600 rounded-full flex items-center justify-center">
                          <User className="w-4 h-4 text-white" />
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {isAgentTyping && (
                  <div className="flex gap-4 justify-start">
                    <div className="flex-shrink-0">
                      <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
                        <Bot className="w-4 h-4 text-white" />
                      </div>
                    </div>
                    <div className="bg-gray-100 dark:bg-gray-700 rounded-lg px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-gray-600 dark:text-gray-300">AI Agent is responding...</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Message input */}
        <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="max-w-4xl mx-auto px-4 py-4">
            <div className="flex gap-4">
              <textarea
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Enter your message..."
                className="flex-1 resize-none border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                rows={3}
                disabled={isSending}
              />
              <Button
                onClick={sendMessage}
                disabled={!inputMessage.trim() || isSending}
                size="lg"
                className="self-end"
              >
                {isSending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
