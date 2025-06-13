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
import { Copy, Loader2, Plus, RefreshCcw, Trash2 } from 'lucide-react';
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

interface ApiKeyClientActionsProps {
  apiKeys: ApiKeyItem[];
}

export default function ApiKeyClientActions({ apiKeys }: ApiKeyClientActionsProps) {
  const t = useTranslations('api_settings');
  const router = useRouter();
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
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
        setNewApiKey(result.data.apiKey);
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
      <form onSubmit={handleSubmitWithAction} className="flex items-center gap-4 mb-6">
        <Input
          placeholder={t('createDesc')}
          {...register('description')}
          disabled={isCreating}
        />
        <Button type="submit" disabled={isCreating} className="flex gap-2 items-center">
          {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {isCreating ? t('creatingKey') : t('createKey')}
        </Button>
      </form>
      {formState.errors.description && (
        <p className="text-red-500 text-sm mb-4">{formState.errors.description.message}</p>
      )}

      {newApiKey && (
        <div className="mt-4 p-4 border border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800 rounded-md">
          <div className="mb-2 text-sm font-medium text-green-800 dark:text-green-400">{t('newKeyCreated')}</div>
          <div className="flex items-center gap-2">
            <code className="p-2 bg-green-100 dark:bg-green-900/40 rounded text-sm flex-grow break-all">
              {newApiKey}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyToClipboard(newApiKey)}
              className="flex gap-2 items-center"
            >
              <Copy className="h-4 w-4" /> {t('copyKey')}
            </Button>
          </div>
        </div>
      )}

      {/* Delete buttons for each key */}
      {apiKeys.map((key) => (
        <div
          key={`delete-button-${key.SK}`}
          className="absolute right-4 top-1/2 transform -translate-y-1/2"
          style={{
            position: 'relative',
            float: 'right',
            marginTop: `-${apiKeys.indexOf(key) * 72 + 36}px`,
            marginRight: '16px',
          }}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleDeleteKey(key.SK)}
            className="text-red-600 hover:text-red-700 dark:text-red-500 dark:hover:text-red-400 flex gap-2 items-center"
          >
            <Trash2 className="h-4 w-4" /> {t('deleteKey')}
          </Button>
        </div>
      ))}

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
    </>
  );
}
