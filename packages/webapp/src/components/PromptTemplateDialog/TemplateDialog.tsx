'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { useAction } from 'next-safe-action/hooks';
import { toast } from 'sonner';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('prompt_template');
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
        toast.success(t('createSuccess'));
        setMode('list');
        window.location.reload(); // Reload page to show the latest templates
      },
      onError: (error) => {
        toast.error(error.serverError || t('createError'));
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
        toast.success(t('updateSuccess'));
        setMode('list');
        setEditingTemplate(null);
        window.location.reload(); // Reload page to show the latest templates
      },
      onError: (error) => {
        toast.error(error.serverError || t('updateError'));
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
      toast.success(t('deleteSuccess'));
      setDeleteConfirmOpen(false);
      setTemplateToDelete(null);
      window.location.reload(); // Reload page to show the latest templates
    },
    onError: (error) => {
      toast.error(error.serverError || t('deleteError'));
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
            {mode === 'list' && t('title')}
            {mode === 'create' && t('createTitle')}
            {mode === 'edit' && t('editTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {mode === 'list' && t('description')}
            {(mode === 'create' || mode === 'edit') && t('formDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* List mode */}
        {mode === 'list' && (
          <>
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {templates.length === 0 ? (
                <div className="text-center py-8 text-gray-500">{t('noTemplates')}</div>
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
                            {t('edit')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDeleteClick(template.SK)}
                            className="flex gap-1 items-center text-red-600 hover:text-red-700"
                          >
                            <Trash2 className="h-3 w-3" />
                            {t('delete')}
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
                        {t('useTemplate')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <AlertDialogFooter className="flex justify-between">
              <Button onClick={() => setMode('create')} variant="outline" className="flex gap-1 items-center">
                <Plus className="h-4 w-4" />
                {t('createNew')}
              </Button>
              <AlertDialogCancel>{t('close')}</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        )}

        {/* Create mode */}
        {mode === 'create' && (
          <form onSubmit={createForm.handleSubmit(handleCreateSubmit)}>
            <div className="space-y-4">
              <div>
                <label htmlFor="title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('titleLabel')}
                </label>
                <Input
                  id="title"
                  placeholder={t('titlePlaceholder')}
                  {...createForm.register('title')}
                  disabled={isCreating}
                />
                {createForm.formState.errors.title && (
                  <p className="text-red-500 text-sm mt-1">{createForm.formState.errors.title.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="content" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('contentLabel')}
                </label>
                <textarea
                  id="content"
                  placeholder={t('contentPlaceholder')}
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
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={isCreating} className="flex gap-2 items-center">
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> {t('creating')}
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" /> {t('save')}
                  </>
                )}
              </Button>
            </div>
          </form>
        )}

        {/* Edit mode */}
        {mode === 'edit' && (
          <form onSubmit={updateForm.handleSubmit(handleUpdateSubmit)}>
            <input type="hidden" {...updateForm.register('id')} />
            <div className="space-y-4">
              <div>
                <label htmlFor="title" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('titleLabel')}
                </label>
                <Input
                  id="title"
                  placeholder={t('titlePlaceholder')}
                  {...updateForm.register('title')}
                  disabled={isUpdating}
                />
                {updateForm.formState.errors.title && (
                  <p className="text-red-500 text-sm mt-1">{updateForm.formState.errors.title.message}</p>
                )}
              </div>
              <div>
                <label htmlFor="content" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('contentLabel')}
                </label>
                <textarea
                  id="content"
                  placeholder={t('contentPlaceholder')}
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
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={isUpdating} className="flex gap-2 items-center">
                {isUpdating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> {t('updating')}
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" /> {t('update')}
                  </>
                )}
              </Button>
            </div>
          </form>
        )}

        {/* Delete confirmation dialog */}
        <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('deleteConfirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('deleteConfirmDescription')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>{t('cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                disabled={isDeleting}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('deleting')}
                  </>
                ) : (
                  t('confirmDelete')
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </AlertDialogContent>
    </AlertDialog>
  );
}
