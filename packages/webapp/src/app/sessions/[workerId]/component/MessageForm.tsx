'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { sendMessageToAgent } from '../actions';
import { sendMessageToAgentSchema } from '../schemas';
import { KeyboardEventHandler } from 'react';

type MessageFormProps = {
  onSubmit: (message: string) => void;
  workerId: string;
};

export default function MessageForm({ onSubmit, workerId }: MessageFormProps) {
  const {
    form: { register, formState, reset, watch },
    action: { isExecuting },
    handleSubmitWithAction,
  } = useHookFormAction(sendMessageToAgent, zodResolver(sendMessageToAgentSchema), {
    actionProps: {
      onSuccess: (args) => {
        onSubmit(message);
        reset();
      },
      onError: ({ error }) => {
        toast.error(typeof error === 'string' ? error : 'Failed to create session');
      },
    },
    formProps: {
      defaultValues: {
        message: '',
        workerId: workerId,
      },
    },
  });

  const message = watch('message');

  const enterPost: KeyboardEventHandler = (keyEvent) => {
    if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.altKey)) {
      // handleSubmitWithAction()
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="max-w-4xl mx-auto px-4 py-4">
        <form onSubmit={handleSubmitWithAction} className="flex gap-4">
          <textarea
            {...register('message')}
            placeholder="Enter your message..."
            className="flex-1 resize-none border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            rows={3}
            disabled={isExecuting}
            onKeyDown={enterPost}
          />
          <input hidden {...register('workerId')} />
          <Button type="submit" disabled={!message.trim() || isExecuting} size="lg" className="self-end">
            {isExecuting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </form>
      </div>
    </div>
  );
}
