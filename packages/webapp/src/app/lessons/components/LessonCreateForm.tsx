'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { MAX_LESSON_CONTENT_LENGTH, MAX_LESSON_CATEGORY_LENGTH } from '@remote-swe-agents/agent-core/schema';
import { createUserLesson } from '@/actions/lesson/action';

export default function LessonCreateForm() {
  const t = useTranslations('lessons');
  const router = useRouter();
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');

  const { execute, isPending } = useAction(createUserLesson, {
    onSuccess: () => {
      toast.success(t('createSuccess'));
      setContent('');
      setCategory('');
      router.refresh();
    },
    onError: ({ error }) => {
      toast.error(error.serverError ?? t('createError'));
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('fields.content')}</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('contentPlaceholder')}
          disabled={isPending}
          maxLength={MAX_LESSON_CONTENT_LENGTH}
          rows={4}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 text-right">
          {content.length} / {MAX_LESSON_CONTENT_LENGTH}
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('fields.category')}
        </label>
        <Input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder={t('categoryPlaceholder')}
          disabled={isPending}
          maxLength={MAX_LESSON_CATEGORY_LENGTH}
        />
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => execute({ content, category: category || undefined })}
          disabled={isPending || content.trim().length === 0}
        >
          {isPending ? t('creating') : t('create.button')}
        </Button>
      </div>
    </div>
  );
}
