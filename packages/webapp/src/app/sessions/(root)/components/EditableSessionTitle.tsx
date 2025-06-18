'use client';

import { useState, useRef, useEffect } from 'react';
import { PencilIcon, CheckIcon, XIcon } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { Button } from '@/components/ui/button';
import { updateSessionTitleAction } from '../actions/update-session-title';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

interface EditableSessionTitleProps {
  workerId: string;
  initialTitle?: string;
  fallbackTitle: string;
}

export default function EditableSessionTitle({ workerId, initialTitle, fallbackTitle }: EditableSessionTitleProps) {
  const t = useTranslations('sessions');
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(initialTitle || fallbackTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  const { execute } = useAction(updateSessionTitleAction, {
    onSuccess: () => {
      toast.success(t('titleUpdatedSuccess'));
      setIsEditing(false);
    },
    onError: (error) => {
      toast.error(error?.error?.serverError || t('titleUpdateError'));
    },
  });

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const handleSave = () => {
    if (title.trim()) {
      execute({ workerId, title: title.trim() });
    } else {
      toast.error(t('titleCannotBeEmpty'));
    }
  };

  const handleCancel = () => {
    setTitle(initialTitle || fallbackTitle);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-1 w-full">
        <input
          ref={inputRef}
          type="text"
          className="text-sm font-semibold bg-transparent border border-blue-500 rounded px-1 py-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500 w-full dark:text-white dark:bg-gray-800"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={100}
        />
        <Button onClick={handleSave} size="sm" variant="ghost" className="h-6 w-6 p-0 flex-shrink-0" title={t('save')}>
          <CheckIcon className="h-3 w-3 text-green-500" />
        </Button>
        <Button
          onClick={handleCancel}
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 flex-shrink-0"
          title={t('cancel')}
        >
          <XIcon className="h-3 w-3 text-red-500" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 w-full group/title">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate flex-1">
        {initialTitle || fallbackTitle}
      </h3>
      <Button
        onClick={() => setIsEditing(true)}
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0 opacity-0 group-hover/title:opacity-100 group-hover:opacity-100 transition-opacity"
        title={t('editTitle')}
      >
        <PencilIcon className="h-3 w-3" />
      </Button>
    </div>
  );
}
