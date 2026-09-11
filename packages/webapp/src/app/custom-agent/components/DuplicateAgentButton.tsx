'use client';

import { useAction } from 'next-safe-action/hooks';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { duplicateCustomAgentAction } from '../actions';

type DuplicateAgentButtonProps = {
  agentId: string;
  variant?: 'icon' | 'labeled';
};

export default function DuplicateAgentButton({ agentId, variant = 'icon' }: DuplicateAgentButtonProps) {
  const t = useTranslations('customAgent');
  const router = useRouter();
  const { execute, isPending } = useAction(duplicateCustomAgentAction, {
    onSuccess: () => {
      toast.success(t('duplicateSuccess'));
      router.refresh();
    },
    onError: ({ error }) => {
      const errorMessage = typeof error === 'string' ? error : t('duplicateError');
      toast.error(errorMessage);
    },
  });

  if (variant === 'labeled') {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => execute({ id: agentId })}
        className="flex items-center gap-1.5"
      >
        <CopyIcon className="h-4 w-4" />
        {t('duplicate')}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={isPending}
      aria-label={t('duplicate')}
      title={t('duplicate')}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        execute({ id: agentId });
      }}
      className="h-8 w-8 text-gray-500 hover:text-gray-900 dark:hover:text-white"
    >
      <CopyIcon className="h-4 w-4" />
    </Button>
  );
}
