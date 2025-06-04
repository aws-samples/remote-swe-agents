'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { createNewWorker } from './actions';
import { createNewWorkerSchema } from './schemas';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

export default function NewSessionPage() {
  const router = useRouter();
  const t = useTranslations('new_session');
  const sessionsT = useTranslations('sessions');

  const {
    form: { register, formState, reset },
    action: { isExecuting },
    handleSubmitWithAction,
  } = useHookFormAction(createNewWorker, zodResolver(createNewWorkerSchema), {
    actionProps: {
      onSuccess: (args) => {
        if (args.data) {
          router.push(`/sessions/${args.data.workerId}`);
        }
      },
      onError: ({ error }) => {
        toast.error(typeof error === 'string' ? error : 'Failed to create session');
      },
    },
    formProps: {
      defaultValues: {
        message: '',
      },
    },
  });

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
              {sessionsT('backToSessions')}
            </Link>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
          </div>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8">
            <div className="text-center">
              <MessageSquare className="w-16 h-16 text-blue-600 dark:text-blue-400 mx-auto mb-6" />
              <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">{t('heading')}</h2>
              <p className="text-gray-600 dark:text-gray-300 mb-8">{t('description')}</p>

              <div className="space-y-4">
                <div className="text-left bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-white">{t('whatYouCanDo')}</h3>
                  <ul className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
                    <li>• {t('features.code')}</li>
                    <li>• {t('features.file')}</li>
                    <li>• {t('features.command')}</li>
                    <li>• {t('features.github')}</li>
                    <li>• {t('features.monitoring')}</li>
                  </ul>
                </div>

                <form onSubmit={handleSubmitWithAction} className="space-y-6">
                  <div className="text-left">
                    <label
                      htmlFor="message"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
                    >
                      {t('initialMessage')}
                    </label>
                    <textarea
                      id="message"
                      {...register('message')}
                      placeholder={t('placeholder')}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
                      rows={4}
                      disabled={isExecuting}
                    />
                    {formState.errors.message && (
                      <p className="mt-1 text-sm text-red-600 dark:text-red-400">{formState.errors.message.message}</p>
                    )}
                  </div>

                  <Button type="submit" disabled={isExecuting || !formState.isValid} className="w-full" size="lg">
                    {isExecuting ? t('creatingSession') : t('createSessionButton')}
                  </Button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
