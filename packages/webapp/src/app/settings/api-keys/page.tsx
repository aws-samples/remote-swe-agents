'use client';

import Header from '@/components/Header';
import { createApiKeyAction, deleteApiKeyAction, listApiKeysAction } from '@/actions/api-key';
import { useAction } from 'next-safe-action/hooks';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { formatDistanceToNow } from 'date-fns';

export default function ApiKeysPage() {
  const [description, setDescription] = useState('');
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [keyToDelete, setKeyToDelete] = useState<string | null>(null);

  // List API keys action
  const { 
    data: apiKeysData, 
    execute: executeListApiKeys, 
    isExecuting: isLoading 
  } = useAction(listApiKeysAction, {
    onError: (error) => {
      toast.error(error.serverError || 'Failed to load API keys');
    }
  });

  // Create API key action
  const { 
    execute: executeCreateApiKey,
    isExecuting: isCreating 
  } = useAction(createApiKeyAction, {
    onSuccess: (data) => {
      setNewApiKey(data.apiKey);
      setDescription('');
      toast.success('API key created successfully');
      executeListApiKeys();
    },
    onError: (error) => {
      toast.error(error.serverError || 'Failed to create API key');
    }
  });

  // Delete API key action
  const { 
    execute: executeDeleteApiKey,
    isExecuting: isDeleting 
  } = useAction(deleteApiKeyAction, {
    onSuccess: () => {
      toast.success('API key deleted successfully');
      executeListApiKeys();
      setIsDeleteDialogOpen(false);
      setKeyToDelete(null);
    },
    onError: (error) => {
      toast.error(error.serverError || 'Failed to delete API key');
      setIsDeleteDialogOpen(false);
    }
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

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        toast.success('API key copied to clipboard');
      },
      () => {
        toast.error('Failed to copy API key');
      }
    );
  }, []);

  // Load API keys on page load
  useState(() => {
    executeListApiKeys();
  });

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />
      <main className="flex-grow">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">API Keys</h1>
            <Button
              onClick={() => executeListApiKeys()}
              variant="outline"
              size="sm"
              disabled={isLoading}
              className="flex gap-2 items-center"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>

          <div className="mb-8">
            <Card>
              <CardHeader>
                <CardTitle>Create New API Key</CardTitle>
                <CardDescription>
                  API keys are used to authenticate HTTP API requests. They should be kept secret.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <Input
                    placeholder="API Key Description (optional)"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={isCreating}
                  />
                  <Button
                    onClick={handleCreateKey}
                    disabled={isCreating}
                    className="flex gap-2 items-center"
                  >
                    {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    Create Key
                  </Button>
                </div>
                {newApiKey && (
                  <div className="mt-4 p-4 border border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800 rounded-md">
                    <div className="mb-2 text-sm font-medium text-green-800 dark:text-green-400">
                      New API key created - Save this key now, you won't be able to see it again!
                    </div>
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
                        <Copy className="h-4 w-4" /> Copy
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Your API Keys</CardTitle>
              <CardDescription>
                These are the API keys associated with your account. When making API requests,
                include the key in the Authorization header as "Bearer YOUR_API_KEY".
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
                </div>
              ) : (
                <div className="space-y-4">
                  {(!apiKeysData?.apiKeys || apiKeysData.apiKeys.length === 0) && (
                    <p className="text-gray-500 dark:text-gray-400 text-center py-4">
                      No API keys found. Create one to get started.
                    </p>
                  )}
                  {apiKeysData?.apiKeys.map((key) => (
                    <div
                      key={key.SK}
                      className="p-4 border border-gray-200 dark:border-gray-800 rounded-md flex justify-between items-center"
                    >
                      <div>
                        <div className="text-sm font-medium">{key.description || 'Unnamed key'}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          Created {formatDistanceToNow(new Date(key.createdAt), { addSuffix: true })}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteKey(key.SK)}
                        className="text-red-600 hover:text-red-700 dark:text-red-500 dark:hover:text-red-400 flex gap-2 items-center"
                      >
                        <Trash2 className="h-4 w-4" /> Delete
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="mt-8">
            <Card>
              <CardHeader>
                <CardTitle>API Documentation</CardTitle>
                <CardDescription>
                  How to use the Remote SWE Agents API
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-6">
                  <div>
                    <h3 className="text-lg font-medium mb-2">Authentication</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">
                      All API requests require authentication using an API key. Include your API key in the Authorization header:
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>Authorization: Bearer YOUR_API_KEY</code>
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-lg font-medium mb-2">Create a new session</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">
                      Create a new agent session with an initial message:
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`POST /api/sessions/

{
  "message": "Your initial message to the agent"
}`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">
                      Returns a workerId that can be used to send additional messages:
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`{
  "workerId": "api-1234567890"
}`}</code>
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-lg font-medium mb-2">Send message to a session</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">
                      Send a follow-up message to an existing session:
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`POST /api/sessions/:sessionId

{
  "message": "Your follow-up message to the agent"
}`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">
                      Replace <code>:sessionId</code> with the workerId returned when creating the session.
                    </p>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">
                      Returns a success status:
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`{
  "success": true
}`}</code>
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-lg font-medium mb-2">Example cURL requests</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">
                      Create a new session:
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`curl -X POST \\
  https://yourwebapp.com/api/sessions/ \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"message": "Create a React component for a user profile page"}'`}</code>
                    </pre>

                    <p className="text-gray-600 dark:text-gray-300 mt-4 mb-2">
                      Send follow-up message:
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`curl -X POST \\
  https://yourwebapp.com/api/sessions/api-1234567890 \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"message": "Add dark mode support to the component"}'`}</code>
                    </pre>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      {/* Delete confirmation dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this API key and
              revoke access for any services using it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteKey}
              disabled={isDeleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}