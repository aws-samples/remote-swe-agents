'use client';

import { createApiKeyAction, deleteApiKeyAction, listApiKeysAction } from '@/actions/api-key';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiKeyItem } from '@remote-swe-agents/agent-core/schema';
import { useAction } from 'next-safe-action/hooks';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { createApiKeySchema } from '@/actions/api-key/schemas';
import { formatDistanceToNow } from 'date-fns';

interface ApiKeyClientActionsProps {
  apiKeys: ApiKeyItem[];
}

export default function ApiKeyClientActions({ apiKeys }: ApiKeyClientActionsProps) {
  const t = useTranslations('api_settings');
  const router = useRouter();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [keyToDelete, setKeyToDelete] = useState<string | null>(null);

  // Create API key action with React Hook Form
  const {
    form: { register, formState, reset },
    action: { isExecuting: isCreating },
    handleSubmitWithAction,
  } = useHookFormAction(createApiKeyAction, zodResolver(createApiKeySchema), {
    actionProps: {
      onSuccess: (result) => {
        if (!result.data) return;
        reset();
        toast.success(t('createSuccess'));
        router.refresh();
      },
      onError: (result) => {
        toast.error(result.error.serverError || t('createError'));
      },
    },
    formProps: {
      defaultValues: {
        description: '',
      },
    },
  });

  // Delete API key action
  const { execute: executeDeleteApiKey, isExecuting: isDeleting } = useAction(deleteApiKeyAction, {
    onSuccess: () => {
      toast.success(t('deleteSuccess'));
      setIsDeleteDialogOpen(false);
      setKeyToDelete(null);
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.error.serverError || t('deleteError'));
      setIsDeleteDialogOpen(false);
    },
  });

  const handleDeleteKey = useCallback((apiKey: string) => {
    setKeyToDelete(apiKey);
    setIsDeleteDialogOpen(true);
  }, []);

  const confirmDeleteKey = useCallback(() => {
    if (keyToDelete) {
      executeDeleteApiKey({ apiKey: keyToDelete });
    }
  }, [executeDeleteApiKey, keyToDelete]);

  const copyToClipboard = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text).then(
        () => {
          toast.success(t('keyCopied'));
        },
        () => {
          toast.error(t('copyFailed'));
        }
      );
    },
    [t]
  );

  return (
    <>
      <div className="mb-8">
        <div className="rounded-lg border border-gray-200 bg-white text-gray-950 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-50">
          <div className="flex flex-col space-y-1.5 p-6">
            <h3 className="text-2xl font-semibold leading-none tracking-tight">{t('createNew')}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('createDesc')}</p>
          </div>
          <div className="p-6 pt-0">
            <form onSubmit={handleSubmitWithAction} className="flex items-center gap-4 mb-6">
              <Input placeholder={t('descriptionPlaceholder')} {...register('description')} disabled={isCreating} />
              {formState.errors.description && (
                <p className="text-red-500 text-sm mb-4">{formState.errors.description.message}</p>
              )}
              <Button type="submit" disabled={isCreating} className="flex gap-2 items-center">
                {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {isCreating ? t('creatingKey') : t('createKey')}
              </Button>
            </form>

            {/* Delete confirmation dialog */}
            <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('deleteConfirmTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('deleteConfirmDesc')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isDeleting}>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={confirmDeleteKey}
                    disabled={isDeleting}
                    className="bg-red-600 hover:bg-red-700 text-white"
                  >
                    {isDeleting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('deletingKey')}
                      </>
                    ) : (
                      t('deleteKey')
                    )}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white text-gray-950 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-50">
        <div className="flex flex-col space-y-1.5 p-6">
          <h3 className="text-2xl font-semibold leading-none tracking-tight">{t('yourKeys')}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('yourKeysDesc')}</p>
        </div>
        <div className="p-6 pt-0">
          <div className="space-y-4">
            {(!apiKeys || apiKeys.length === 0) && (
              <p className="text-gray-500 dark:text-gray-400 text-center py-4">{t('noKeys')}</p>
            )}
            {apiKeys.map((key: ApiKeyItem) => (
              <div key={key.SK} className="flex items-center justify-between p-4 border rounded-md bg-card">
                <div className="flex-1">
                  <div className="text-sm font-medium">{key.description || t('unnamedKey')}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('createdAgo', {
                      timeAgo: formatDistanceToNow(new Date(key.createdAt), { addSuffix: true }),
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(key.SK)}
                    className="flex gap-2 items-center"
                  >
                    <Copy className="h-4 w-4" /> {t('copyKey')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDeleteKey(key.SK)}
                    className="text-red-600 hover:text-red-700 dark:text-red-500 dark:hover:text-red-400 flex gap-2 items-center"
                  >
                    <Trash2 className="h-4 w-4" /> {t('deleteKey')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
