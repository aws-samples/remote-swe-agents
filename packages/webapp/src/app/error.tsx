'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { classifyStaleDeploymentError, reloadForStaleDeployment } from '@/lib/deployment-recovery';

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  const t = useTranslations('common.errorPage');

  useEffect(() => {
    console.error('Route error boundary caught:', error);
    // A ChunkLoadError here means the page is running a stale build whose
    // chunks no longer exist; a reload fetches the current build (guarded
    // against loops by reloadForStaleDeployment).
    if (classifyStaleDeploymentError(error, window.sessionStorage) === 'reload') {
      reloadForStaleDeployment();
    }
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8 text-center">
        <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">{t('title')}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">{t('description')}</p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button onClick={() => window.location.reload()} className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4" />
            {t('reload')}
          </Button>
          <Link href="/">
            <Button variant="outline" className="flex items-center gap-2 w-full">
              <Home className="w-4 h-4" />
              {t('backToHome')}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
