'use client';

import { createApiKeyAction, deleteApiKeyAction, listApiKeysAction } from '@/actions/api-key';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiKeyItem } from '@remote-swe-agents/agent-core/schema';
import { useAction } from 'next-safe-action/hooks';
import { useCallback, useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, Plus, RefreshCcw, Trash2 } from 'lucide-react';
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

interface ApiKeyClientActionsProps {
  apiKeys: ApiKeyItem[];
}

export default function ApiKeyClientActions({ apiKeys: initialApiKeys }: ApiKeyClientActionsProps) {
  const t = useTranslations('api_settings');
  const [description, setDescription] = useState('');
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [keyToDelete, setKeyToDelete] = useState<string | null>(null);
  const [localApiKeys, setLocalApiKeys] = useState<ApiKeyItem[]>(initialApiKeys || []);

  // List API keys action
  const {
    data: apiKeysData,
    execute: executeListApiKeys,
    isExecuting: isLoading,
  } = useAction(listApiKeysAction, {
    onSuccess: (data) => {
      setLocalApiKeys(data.apiKeys || []);
    },
    onError: (error) => {
      toast.error(error.serverError || t('loadError'));
    },
  });

  // Create API key action
  const { execute: executeCreateApiKey, isExecuting: isCreating } = useAction(createApiKeyAction, {
    onSuccess: (data) => {
      setNewApiKey(data.apiKey);
      setDescription('');
      toast.success(t('createSuccess'));
      executeListApiKeys();
    },
    onError: (error) => {
      toast.error(error.serverError || t('createError'));
    },
  });

  // Delete API key action
  const { execute: executeDeleteApiKey, isExecuting: isDeleting } = useAction(deleteApiKeyAction, {
    onSuccess: () => {
      toast.success(t('deleteSuccess'));
      executeListApiKeys();
      setIsDeleteDialogOpen(false);
      setKeyToDelete(null);
    },
    onError: (error) => {
      toast.error(error.serverError || t('deleteError'));
      setIsDeleteDialogOpen(false);
    },
  });

  const handleCreateKey = useCallback(() => {
    executeCreateApiKey({ description });
  }, [executeCreateApiKey, description]);

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
      <div className="flex items-center gap-4 mb-6">
        <Input
          placeholder={t('createDesc')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={isCreating}
        />
        <Button onClick={handleCreateKey} disabled={isCreating} className="flex gap-2 items-center">
          {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {isCreating ? t('creatingKey') : t('createKey')}
        </Button>
      </div>

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

      {/* Refresh button at the top of Your API Keys section */}
      <div className="flex justify-end -mt-2 mb-4">
        <Button
          onClick={() => executeListApiKeys()}
          variant="outline"
          size="sm"
          disabled={isLoading}
          className="flex gap-2 items-center"
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          {t('refresh')}
        </Button>
      </div>

      {/* Delete buttons for each key */}
      {localApiKeys.map((key) => (
        <div
          key={`delete-button-${key.SK}`}
          className="absolute right-4 top-1/2 transform -translate-y-1/2"
          style={{
            position: 'relative',
            float: 'right',
            marginTop: `-${localApiKeys.indexOf(key) * 72 + 36}px`,
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
