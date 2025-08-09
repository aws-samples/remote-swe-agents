'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useAction } from 'next-safe-action/hooks';
import { getModelSettingAction, saveModelSettingAction } from '../actions';
import { Save } from 'lucide-react';
import { toast } from 'sonner';

export default function ModelForm() {
  const [isLoading, setIsLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState('sonnet3.7');

  const { execute: fetchSettings } = useAction(getModelSettingAction, {
    onSuccess: (data) => {
      if (data.modelId) {
        setSelectedModel(data.modelId);
      }
      setIsLoading(false);
    },
    onError: (error) => {
      toast.error('Failed to load model settings');
      setIsLoading(false);
    },
  });

  const { execute: saveModel, status: saveStatus } = useAction(saveModelSettingAction, {
    onSuccess: () => {
      toast.success('Model settings saved successfully');
    },
    onError: (error) => {
      const errorMessage = error.error?.serverError || 'Failed to save model settings';
      toast.error(errorMessage);
    },
  });

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleSave = () => {
    saveModel({ modelId: selectedModel });
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedModel(e.target.value);
  };

  if (isLoading) {
    return <div>Loading model settings...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <label htmlFor="model-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Select Foundation Model
        </label>
        <select
          id="model-select"
          value={selectedModel}
          onChange={handleModelChange}
          className="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          <option value="sonnet3.7">Claude 3.5 Sonnet</option>
          <option value="opus">Claude 3 Opus</option>
          <option value="sonnet">Claude 3 Sonnet</option>
        </select>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          This setting will apply to all new sessions unless overridden.
        </p>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saveStatus === 'executing'} className="flex items-center gap-2">
          <Save className="h-4 w-4" />
          Save Model
        </Button>
      </div>
    </div>
  );
}
