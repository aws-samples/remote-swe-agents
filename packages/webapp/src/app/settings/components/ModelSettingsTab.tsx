'use client';

import { useAction } from 'next-safe-action/hooks';
import { useEffect, useState } from 'react';
import { getModelSettingAction, saveModelSettingAction } from '../actions';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { modelConfigSchema } from '../schemas';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type FormValues = z.infer<typeof modelConfigSchema>;

export default function ModelSettingsTab() {
  const [isLoading, setIsLoading] = useState(true);

  const { execute: fetchSettings } = useAction(getModelSettingAction, {
    onSuccess: (data) => {
      if (data.modelId) {
        form.setValue('modelId', data.modelId);
      }
      setIsLoading(false);
    },
    onError: (error) => {
      toast.error('Failed to load model settings');
      setIsLoading(false);
    },
  });

  const { execute: saveSettings, status: saveStatus } = useAction(saveModelSettingAction, {
    onSuccess: () => {
      toast.success('Model settings saved successfully');
    },
    onError: (error) => {
      toast.error(error.serverError || 'Failed to save model settings');
    },
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(modelConfigSchema),
    defaultValues: {
      modelId: '',
    },
  });

  useEffect(() => {
    fetchSettings();
  }, []);

  const onSubmit = (data: FormValues) => {
    saveSettings(data);
  };

  if (isLoading) {
    return <div>Loading settings...</div>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default Foundation Model</CardTitle>
        <CardDescription>
          Select the default foundation model to use for all agents.
          Individual agents can override this setting.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="modelId"
              render={({ field }) => (
                <FormItem className="space-y-3">
                  <FormLabel>Foundation Model</FormLabel>
                  <FormControl>
                    <RadioGroup
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      className="flex flex-col space-y-1"
                    >
                      <FormItem className="flex items-center space-x-3 space-y-0">
                        <FormControl>
                          <RadioGroupItem value="sonnet3.7" />
                        </FormControl>
                        <FormLabel className="font-normal">
                          Claude 3.5 Sonnet
                        </FormLabel>
                      </FormItem>
                      <FormItem className="flex items-center space-x-3 space-y-0">
                        <FormControl>
                          <RadioGroupItem value="opus" />
                        </FormControl>
                        <FormLabel className="font-normal">
                          Claude 3 Opus
                        </FormLabel>
                      </FormItem>
                      <FormItem className="flex items-center space-x-3 space-y-0">
                        <FormControl>
                          <RadioGroupItem value="sonnet" />
                        </FormControl>
                        <FormLabel className="font-normal">
                          Claude 3 Sonnet
                        </FormLabel>
                      </FormItem>
                    </RadioGroup>
                  </FormControl>
                  <FormDescription>
                    This setting will apply to all new sessions.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button 
              type="submit" 
              disabled={saveStatus === 'executing'}>
              {saveStatus === 'executing' ? 'Saving...' : 'Save Settings'}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}