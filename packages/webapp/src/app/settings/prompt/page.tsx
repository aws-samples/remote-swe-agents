'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { useAction } from 'next-safe-action/hooks';
import { savePromptAction, getPromptAction } from './actions';
import Header from '@/components/Header';
import { Save } from 'lucide-react';

export default function PromptSettingsPage() {
  const [prompt, setPrompt] = useState<string>('');
  const { toast } = useToast();

  const { execute: getPrompt, result: getResult } = useAction(getPromptAction, {
    onSuccess: (data) => {
      if (data && data.additionalSystemPrompt) {
        setPrompt(data.additionalSystemPrompt);
      }
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Error loading prompt',
        description: error.serverError || 'Failed to load common prompt settings',
      });
    },
  });

  const { execute: savePrompt, status: saveStatus } = useAction(savePromptAction, {
    onSuccess: () => {
      toast({
        title: 'Prompt saved',
        description: 'Common prompt has been successfully saved',
      });
    },
    onError: (error) => {
      toast({
        variant: 'destructive',
        title: 'Error saving prompt',
        description: error.serverError || 'Failed to save common prompt',
      });
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

        <Card className="border border-gray-200 dark:border-gray-800 shadow-sm">
          <CardHeader>
            <CardTitle>Agent Prompt Configuration</CardTitle>
            <CardDescription>
              This prompt will be added to all agents' system prompt. Use this to set organization-wide guidelines or
              instructions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <Textarea
                  placeholder="Enter common prompt text here..."
                  className="h-64 font-mono"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  id="prompt"
                />
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex justify-end space-x-2">
            <Button onClick={handleSave} disabled={saveStatus === 'executing'} className="flex items-center gap-2">
              <Save className="h-4 w-4" />
              Save Prompt
            </Button>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}
