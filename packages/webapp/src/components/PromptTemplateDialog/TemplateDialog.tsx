'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { useAction } from 'next-safe-action/hooks';
import { toast } from 'sonner';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import {
  promptTemplateSchema,
  updatePromptTemplateSchema,
  deletePromptTemplateSchema,
} from '@/app/sessions/new/schemas';
import {
  createPromptTemplateAction,
  updatePromptTemplateAction,
  deletePromptTemplateAction,
} from '@/app/sessions/new/actions';

interface PromptTemplate {
  SK: string;
  title: string;
  content: string;
  createdAt: number;
}

interface TemplateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (content: string) => void;
  templates: PromptTemplate[];
}

export default function TemplateDialog({ isOpen, onClose, onSelect, templates }: TemplateDialogProps) {
  const [mode, setMode] = useState<'list' | 'create' | 'edit'>('list');
  const [editingTemplate, setEditingTemplate] = useState<PromptTemplate | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);

  // Create template form
  const {
    form: createForm,
    action: { isExecuting: isCreating },
    handleSubmitWithAction: handleCreateSubmit,
  } = useHookFormAction(createPromptTemplateAction, zodResolver(promptTemplateSchema), {
    actionProps: {
      onSuccess: () => {
        toast.success('テンプレートが作成されました');
        setMode('list');
        window.location.reload(); // ページをリロードして最新のテンプレートを表示
      },
      onError: (error) => {
        toast.error(error.serverError || 'テンプレートの作成に失敗しました');
      },
    },
    formProps: {
      defaultValues: {
        title: '',
        content: '',
      },
    },
  });

  // Update template form
  const {
    form: updateForm,
    action: { isExecuting: isUpdating },
    handleSubmitWithAction: handleUpdateSubmit,
  } = useHookFormAction(updatePromptTemplateAction, zodResolver(updatePromptTemplateSchema), {
    actionProps: {
      onSuccess: () => {
        toast.success('テンプレートが更新されました');
        setMode('list');
        setEditingTemplate(null);
        window.location.reload(); // ページをリロードして最新のテンプレートを表示
      },
      onError: (error) => {
        toast.error(error.serverError || 'テンプレートの更新に失敗しました');
      },
    },
    formProps: {
      defaultValues: {
        id: '',
        title: '',
        content: '',
      },
    },
  });

  // Delete template action
  const { execute: executeDeleteTemplate, isExecuting: isDeleting } = useAction(deletePromptTemplateAction, {
    onSuccess: () => {
      toast.success('テンプレートが削除されました');
      setDeleteConfirmOpen(false);
      setTemplateToDelete(null);
      window.location.reload(); // ページをリロードして最新のテンプレートを表示
    },
    onError: (error) => {
      toast.error(error.serverError || 'テンプレートの削除に失敗しました');
      setDeleteConfirmOpen(false);
    },
  });

  const handleEditClick = (template: PromptTemplate) => {
    setEditingTemplate(template);
    updateForm.reset({
      id: template.SK,
      title: template.title,
      content: template.content,
    });
    setMode('edit');
  };

  const handleDeleteClick = (id: string) => {
    setTemplateToDelete(id);
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = () => {
    if (templateToDelete) {
      executeDeleteTemplate({ id: templateToDelete });
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-xl">
            {mode === 'list' && 'プロンプトテンプレート'}
            {mode === 'create' && '新しいテンプレートを作成'}
            {mode === 'edit' && 'テンプレートを編集'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {mode === 'list' && 'テンプレートを選択するか、新しいテンプレートを作成してください。'}
            {(mode === 'create' || mode === 'edit') && 'テンプレートのタイトルと内容を入力してください。'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* リストモード */}
        {mode === 'list' && (
          <>
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {templates.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  テンプレートがありません。新しいテンプレートを作成してください。
                </div>
              ) : (
                <div className="space-y-3">
                  {templates.map((template) => (
                    <div
                      key={template.SK}
                      className="border border-gray-200 dark:border-gray-700 rounded-md p-4 hover:bg-gray-50 dark:hover:bg-gray-800"
                    >
                      <div className="flex justify-between items-center mb-2">
                        <h3 className="font-medium">{template.title}</h3>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEditClick(template)}
                            className="flex gap-1 items-center"
                          >
                            <Pencil className="h-3 w-3" />
                            編集
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDeleteClick(template.SK)}
                            className="flex gap-1 items-center text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="h-3 w-3" />
                            削除
                          </Button>
                        </div>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-3">{template.content}</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2 text-blue-600 dark:text-blue-400"
                        onClick={() => onSelect(template.content)}
                      >
                        このテンプレートを使用
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <AlertDialogFooter className="flex justify-between">
              <Button onClick={() => setMode('create')} variant="outline" className="flex gap-1 items-center">
                <Plus className="h-4 w-4" />
                新規作成
              </Button>
              <AlertDialogCancel>閉じる</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        )}

        {/* 作成モード */}
        {mode === 'create' && (
          <form onSubmit={createForm.handleSubmit(handleCreateSubmit)}>
            <div className="space-y-4">
              <div>
                <label htmlFor="title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  タイトル
                </label>
                <Input
                  id="title"
                  placeholder="テンプレートのタイトル"
                  {...createForm.register('title')}
                  disabled={isCreating}
                />
                {createForm.formState.errors.title && (
                  <p className="text-red-500 text-sm mt-1">{createForm.formState.errors.title.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="content" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  内容
                </label>
                <textarea
                  id="content"
                  placeholder="テンプレートの内容"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
                  rows={4}
                  {...createForm.register('content')}
                  disabled={isCreating}
                />
                {createForm.formState.errors.content && (
                  <p className="text-red-500 text-sm mt-1">{createForm.formState.errors.content.message}</p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <Button type="button" variant="outline" onClick={() => setMode('list')} disabled={isCreating}>
                キャンセル
              </Button>
              <Button type="submit" disabled={isCreating} className="flex gap-2 items-center">
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> 作成中...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" /> 保存
                  </>
                )}
              </Button>
            </div>
          </form>
        )}

        {/* 編集モード */}
        {mode === 'edit' && (
          <form onSubmit={updateForm.handleSubmit(handleUpdateSubmit)}>
            <input type="hidden" {...updateForm.register('id')} />
            <div className="space-y-4">
              <div>
                <label htmlFor="title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  タイトル
                </label>
                <Input
                  id="title"
                  placeholder="テンプレートのタイトル"
                  {...updateForm.register('title')}
                  disabled={isUpdating}
                />
                {updateForm.formState.errors.title && (
                  <p className="text-red-500 text-sm mt-1">{updateForm.formState.errors.title.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="content" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  内容
                </label>
                <textarea
                  id="content"
                  placeholder="テンプレートの内容"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
                  rows={4}
                  {...updateForm.register('content')}
                  disabled={isUpdating}
                />
                {updateForm.formState.errors.content && (
                  <p className="text-red-500 text-sm mt-1">{updateForm.formState.errors.content.message}</p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <Button type="button" variant="outline" onClick={() => setMode('list')} disabled={isUpdating}>
                キャンセル
              </Button>
              <Button type="submit" disabled={isUpdating} className="flex gap-2 items-center">
                {isUpdating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> 更新中...
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" /> 更新
                  </>
                )}
              </Button>
            </div>
          </form>
        )}

        {/* 削除確認ダイアログ */}
        <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>テンプレートを削除しますか？</AlertDialogTitle>
              <AlertDialogDescription>
                この操作は元に戻すことができません。本当にこのテンプレートを削除しますか？
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>キャンセル</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                disabled={isDeleting}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 削除中...
                  </>
                ) : (
                  '削除'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </AlertDialogContent>
    </AlertDialog>
  );
}
