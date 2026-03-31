'use client';

import { useEffect, useCallback } from 'react';
import { useAction } from 'next-safe-action/hooks';
import { getUnreadBadgeInfo } from '@/actions/badge/action';

export default function BadgeSyncer() {
  const { execute } = useAction(getUnreadBadgeInfo, {
    onSuccess: ({ data }) => {
      if (data?.badge && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'UPDATE_BADGE',
          badge: data.badge,
        });
      }
    },
  });

  const syncBadge = useCallback(() => {
    execute({});
  }, [execute]);

  useEffect(() => {
    syncBadge();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncBadge();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [syncBadge]);

  return null;
}
