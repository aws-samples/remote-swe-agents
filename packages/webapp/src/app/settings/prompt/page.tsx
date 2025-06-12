'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useAction } from 'next-safe-action/hooks';
import { savePromptAction, getPromptAction } from './actions';
import Header from '@/components/Header';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

export default function PromptSettingsPage() {
  const [prompt, setPrompt] = useState<string>('');

  const { execute: getPrompt, result: getResult } = useAction(getPromptAction, {
    onSuccess: (result) => {
      if (result && result.data && result.data.additionalSystemPrompt) {
        setPrompt(result.data.additionalSystemPrompt);
      }
    },
    onError: (error) => {
      const errorMessage = error.error?.serverError || 'Failed to load common prompt settings';
      toast.error(errorMessage);
    },
  });

  const { execute: savePrompt, status: saveStatus } = useAction(savePromptAction, {
    onSuccess: () => {
      toast.success('Common prompt has been successfully saved');
    },
    onError: (error) => {
      const errorMessage = error.error?.serverError || 'Failed to save common prompt';
      toast.error(errorMessage);
    },
  });

  // Load prompt on initial page load
  useEffect(() => {
    getPrompt({});
  }, []);

  const handleSave = () => {
    savePrompt({ additionalSystemPrompt: prompt });
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">Common Prompt Settings</h1>
          <p className="text-gray-600 dark:text-gray-300">
            Configure a common prompt that will be added to all agent interactions
          </p>
        </div>

        <div className="border border-gray-200 dark:border-gray-800 shadow-sm rounded-lg bg-white dark:bg-gray-800">
          <div className="p-6 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-1">Agent Prompt Configuration</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              This prompt will be added to all agents' system prompt. Use this to set organization-wide guidelines or
              instructions.
            </p>
          </div>

          <div className="p-6">
            <div className="space-y-4">
              <div>
                <textarea
                  placeholder="Enter common prompt text here..."
                  className="w-full h-64 p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  id="prompt"
                />
              </div>
            </div>
          </div>

          <div className="p-4 flex justify-end border-t border-gray-200 dark:border-gray-700">
            <Button onClick={handleSave} disabled={saveStatus === 'executing'} className="flex items-center gap-2">
              <Save className="h-4 w-4" />
              Save Prompt
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
