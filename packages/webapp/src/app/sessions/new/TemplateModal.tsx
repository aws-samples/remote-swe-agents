'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Plus, Edit, Trash2, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAction } from 'next-safe-action/hooks';
import { useTranslations } from 'next-intl';
import { createPromptTemplate, updatePromptTemplate, deletePromptTemplate } from './template-actions';
import { PromptTemplate } from '@/app/sessions/new/schemas';

interface TemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  templates: PromptTemplate[];
  onSelectTemplate: (template: PromptTemplate) => void;
}

export default function TemplateModal({ isOpen, onClose, templates, onSelectTemplate }: TemplateModalProps) {
  const t = useTranslations('new_session.templateModal');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [newContent, setNewContent] = useState('');

  const { execute: executeCreate, isExecuting: isCreatingTemplate } = useAction(createPromptTemplate, {
    onSuccess: () => {
      setIsCreating(false);
      setNewContent('');
      toast.success(t('createSuccess'));
    },
    onError: ({ error }) => {
      toast.error(typeof error === 'string' ? error : t('createError'));
    },
  });

  const { execute: executeUpdate, isExecuting: isUpdatingTemplate } = useAction(updatePromptTemplate, {
    onSuccess: () => {
      setEditingId(null);
      setEditingContent('');
      toast.success(t('updateSuccess'));
    },
    onError: ({ error }) => {
      toast.error(typeof error === 'string' ? error : t('updateError'));
    },
  });

  const { execute: executeDelete, isExecuting: isDeletingTemplate } = useAction(deletePromptTemplate, {
    onSuccess: () => {
      toast.success(t('deleteSuccess'));
    },
    onError: ({ error }) => {
      toast.error(typeof error === 'string' ? error : t('deleteError'));
    },
  });

  const handleEdit = (template: PromptTemplate) => {
    setEditingId(template.SK);
    setEditingContent(template.content);
  };

  const handleSaveEdit = () => {
    if (!editingId || !editingContent.trim()) return;
    executeUpdate({ id: editingId, content: editingContent });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingContent('');
  };

  const handleDelete = (id: string) => {
    if (!confirm(t('confirmDelete'))) return;
    executeDelete({ id });
  };

  const handleCreate = () => {
    if (!newContent.trim()) return;
    executeCreate({ content: newContent });
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    setNewContent('');
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4">
          {/* Create new template */}
          {isCreating ? (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800">
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder={t('placeholder')}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
                rows={4}
                autoFocus
              />
              <div className="flex gap-2 mt-3">
                <Button onClick={handleCreate} size="sm" disabled={!newContent.trim() || isCreatingTemplate}>
                  <Save className="w-4 h-4 mr-1" />
                  {isCreatingTemplate ? t('saving') : t('save')}
                </Button>
                <Button onClick={handleCancelCreate} size="sm" variant="outline">
                  <X className="w-4 h-4 mr-1" />
                  {t('cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={() => setIsCreating(true)} variant="outline" className="w-full border-dashed">
              <Plus className="w-4 h-4 mr-2" />
              {t('createNew')}
            </Button>
          )}

          {/* Template list */}
          {templates.length === 0 ? (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">{t('noTemplates')}</div>
          ) : (
            <div className="space-y-3">
              {templates.map((template) => (
                <div
                  key={template.SK}
                  className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {editingId === template.SK ? (
                    <div>
                      <textarea
                        value={editingContent}
                        onChange={(e) => setEditingContent(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white resize-vertical"
                        rows={4}
                        autoFocus
                      />
                      <div className="flex gap-2 mt-3">
                        <Button
                          onClick={handleSaveEdit}
                          size="sm"
                          disabled={!editingContent.trim() || isUpdatingTemplate}
                        >
                          <Save className="w-4 h-4 mr-1" />
                          {isUpdatingTemplate ? t('saving') : t('save')}
                        </Button>
                        <Button onClick={handleCancelEdit} size="sm" variant="outline">
                          <X className="w-4 h-4 mr-1" />
                          {t('cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="cursor-pointer mb-3" onClick={() => onSelectTemplate(template)}>
                        <p className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap">
                          {template.content}
                        </p>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {t('createdAt', { date: new Date(template.createdAt).toLocaleDateString() })}
                        </span>
                        <div className="flex gap-2">
                          <Button onClick={() => handleEdit(template)} size="sm" variant="ghost">
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button
                            onClick={() => handleDelete(template.SK)}
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                            disabled={isDeletingTemplate}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
