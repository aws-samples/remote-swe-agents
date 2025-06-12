'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAction } from 'next-safe-action/hooks';
import { savePromptAction } from '../actions';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

interface PromptFormProps {
  initialPrompt: string;
}

export default function PromptForm({ initialPrompt }: PromptFormProps) {
  const [prompt, setPrompt] = useState<string>(initialPrompt);
  const t = useTranslations('prompt_settings');

  const { execute: savePrompt, status: saveStatus } = useAction(savePromptAction, {
    onSuccess: () => {
      toast.success(t('saveSuccess'));
    },
    onError: (error) => {
      const errorMessage = error.error?.serverError || t('saveError');
      toast.error(errorMessage);
    },
  });

  const handleSave = () => {
    savePrompt({ additionalSystemPrompt: prompt });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <textarea
          placeholder={t('placeholder')}
          className="w-full h-64 p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          id="prompt"
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saveStatus === 'executing'} className="flex items-center gap-2">
          <Save className="h-4 w-4" />
          {t('saveButton')}
        </Button>
      </div>
    </div>
  );
}
