'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { classifyStaleDeploymentError, reloadForStaleDeployment } from '@/lib/deployment-recovery';

/**
 * Global safety net for stale-deployment failures that are not handled by a
 * specific form. next-safe-action hooks re-throw Server Action errors after
 * their callbacks, and `<form onSubmit>` does not await the handler promise,
 * so EVERY form's stale-action failure surfaces here as an unhandled
 * rejection — including forms that hold unsaved user input (CustomAgentForm,
 * GlobalPreferencesForm, ...).
 *
 * Therefore this listener never reloads on a stale ACTION error: an automatic
 * reload would silently destroy that unsaved input. It only
 *  - reloads for ChunkLoadError (the page is already missing code, so a
 *    reload cannot make things worse), and
 *  - shows an "app was updated, please reload" toast otherwise, so a failed
 *    save is never a silent dead button.
 * Forms that persist their pending submission for auto-resend (MessageForm /
 * NewSessionForm) reload themselves; `classifyStaleDeploymentError` detects
 * that in-flight reload and keeps this listener quiet ('defer').
 */
export default function DeploymentRecoveryListener() {
  const t = useTranslations('common.deploymentRecovery');

  useEffect(() => {
    const RELOAD_DELAY_MS = 250;
    const notify = () => {
      toast.warning(t('appUpdated'), {
        id: 'stale-deployment-notice',
        duration: 10_000,
        action: {
          label: t('reload'),
          onClick: () => window.location.reload(),
        },
      });
    };
    const handle = (error: unknown): boolean => {
      const decision = classifyStaleDeploymentError(error, window.sessionStorage);
      if (decision === 'ignore') return false;
      if (decision === 'reload') {
        // Defer slightly so a component-level handler observing the same
        // failure gets to run first; the loop guard inside
        // reloadForStaleDeployment makes double-firing a no-op.
        window.setTimeout(() => {
          if (!reloadForStaleDeployment()) notify();
        }, RELOAD_DELAY_MS);
      } else if (decision === 'notify') {
        notify();
      }
      return true;
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (handle(event.reason)) event.preventDefault();
    };
    const onError = (event: ErrorEvent) => {
      if (handle(event.error)) event.preventDefault();
    };
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('error', onError);
    };
  }, [t]);

  return null;
}
