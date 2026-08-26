'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

/**
 * Shows the deleteSuccess toast after a custom agent is deleted from its detail
 * page. Deletion there uses a server-side redirect('/custom-agent?deleted=1')
 * to avoid the revalidate/notFound 404 race, which means the client onSuccess
 * (and its toast) never runs. This listener restores that feedback by reading
 * the ?deleted=1 marker on the list page, then cleans it from the URL.
 */
export default function DeleteSuccessToast() {
  const t = useTranslations('customAgent');
  const router = useRouter();
  const searchParams = useSearchParams();
  const shown = useRef(false);

  useEffect(() => {
    if (searchParams.get('deleted') === '1' && !shown.current) {
      shown.current = true;
      toast.success(t('deleteSuccess'));
      router.replace('/custom-agent');
    }
  }, [searchParams, router, t]);

  return null;
}
