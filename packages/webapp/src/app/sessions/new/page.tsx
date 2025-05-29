'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { createNewSession } from '@/app/(root)/actions';

export default function NewSessionPage() {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);

  const handleCreateSession = async () => {
    setIsCreating(true);
    try {
      const result = await createNewSession({});
      if (result?.data?.workerId) {
        router.push(`/sessions/${result.data.workerId}`);
      }
    } catch (error) {
      console.error('Failed to create session:', error);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow">
        <div className="max-w-2xl mx-auto px-4 py-8">
          <div className="mb-6">
            <Link 
              href="/sessions" 
              className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white mb-4"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Sessions
            </Link>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">New Session</h1>
          </div>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8">
            <div className="text-center">
              <MessageSquare className="w-16 h-16 text-blue-600 dark:text-blue-400 mx-auto mb-6" />
              <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">
                Start a New Conversation with AI Agent
              </h2>
              <p className="text-gray-600 dark:text-gray-300 mb-8">
                Creating a new session will launch a dedicated worker and enable
                real-time conversation with AI agents.
              </p>
              
              <div className="space-y-4">
                <div className="text-left bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-white">What you can do:</h3>
                  <ul className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
                    <li>• Code creation, modification, and review</li>
                    <li>• File reading, writing, and editing</li>
                    <li>• Command execution and debugging</li>
                    <li>• GitHub operations and PR creation</li>
                    <li>• Real-time progress monitoring</li>
                  </ul>
                </div>

                <Button 
                  onClick={handleCreateSession}
                  disabled={isCreating}
                  className="w-full"
                  size="lg"
                >
                  {isCreating ? 'Creating...' : 'Create Session'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
