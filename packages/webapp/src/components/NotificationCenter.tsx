'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Bell } from 'lucide-react';
import { Button } from './ui/button';
import { useAction } from 'next-safe-action/hooks';
import { getUnreadSessionDetailsAction, markAllReadAction } from '@/actions/badge/action';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEventBus } from '@/hooks/use-event-bus';
import { webappEventSchema } from '@remote-swe-agents/agent-core/schema';
import { usePathname } from 'next/navigation';
import { getUnifiedStatus } from '@/utils/session-status';
import type { AgentStatus, InstanceStatus } from '@remote-swe-agents/agent-core/schema';

interface UnreadSession {
  workerId: string;
  unreadCount: number;
  hasPending: boolean;
  updatedAt: number;
  title?: string;
  agentStatus?: string;
  instanceStatus?: string;
}

export default function NotificationCenter({ userId }: { userId: string }) {
  const t = useTranslations('notifications');
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [sessions, setSessions] = useState<UnreadSession[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [isPushSupported, setIsPushSupported] = useState(false);
  const [isPushSubscribed, setIsPushSubscribed] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Derive current session workerId from URL
  const currentWorkerId = pathname.startsWith('/sessions/') ? pathname.split('/')[2] : null;

  // Check push notification status
  useEffect(() => {
    const checkPush = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return;
      }
      setIsPushSupported(true);
      try {
        const registration = await navigator.serviceWorker.getRegistration('/sw.js');
        if (registration) {
          const subscription = await registration.pushManager.getSubscription();
          setIsPushSubscribed(!!subscription);
        }
      } catch {
        // ignore
      }
    };
    checkPush();
  }, []);

  // Fetch unread session details (used for both badge count and dropdown)
  const { execute: fetchDetails, isExecuting: isLoadingDetails } = useAction(getUnreadSessionDetailsAction, {
    onSuccess: ({ data }) => {
      if (data?.sessions) {
        setSessions(data.sessions);
        const total = data.sessions.reduce((sum, s) => sum + Math.max(s.unreadCount, s.hasPending ? 1 : 0), 0);
        setTotalUnread(total);
      }
    },
  });

  // Mark all read
  const { execute: executeMarkAllRead, isExecuting: isMarkingAllRead } = useAction(markAllReadAction, {
    onSuccess: ({ data }) => {
      setSessions([]);
      setTotalUnread(0);
      if (data?.badge && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'UPDATE_BADGE',
          badge: data.badge,
        });
      }
    },
  });

  // Fetch on mount, navigation changes (markSessionRead clears unread), and visibility
  useEffect(() => {
    fetchDetails({});

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchDetails({});
      }
    };

    // Listen for session-read events from SessionPageClient
    const handleSessionRead = () => {
      fetchDetails({});
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('session-read', handleSessionRead);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('session-read', handleSessionRead);
    };
  }, [fetchDetails, pathname]);

  // Real-time updates via EventBus
  useEventBus({
    channelName: 'webapp/worker/*',
    onReceived: useCallback(
      (payload: unknown) => {
        try {
          const event = webappEventSchema.parse(payload);

          if (event.type === 'unreadUpdate') {
            if (event.userId !== userId) return;

            setSessions((prev) => {
              const existing = prev.find((s) => s.workerId === event.workerId);
              let next: UnreadSession[];
              if (existing) {
                const updated = prev.map((s) =>
                  s.workerId === event.workerId
                    ? { ...s, unreadCount: event.unreadCount, hasPending: event.hasPending, updatedAt: Date.now() }
                    : s
                );
                next =
                  event.unreadCount === 0 && !event.hasPending
                    ? updated.filter((s) => s.workerId !== event.workerId)
                    : updated;
              } else if (event.unreadCount > 0 || event.hasPending) {
                next = [
                  ...prev,
                  {
                    workerId: event.workerId,
                    unreadCount: event.unreadCount,
                    hasPending: event.hasPending,
                    updatedAt: Date.now(),
                  },
                ];
              } else {
                next = prev;
              }
              setTotalUnread(next.reduce((sum, s) => sum + Math.max(s.unreadCount, s.hasPending ? 1 : 0), 0));
              return next;
            });
          }

          // Update title in real-time
          if (event.type === 'sessionTitleUpdate') {
            setSessions((prev) =>
              prev.map((s) => (s.workerId === event.workerId ? { ...s, title: event.newTitle } : s))
            );
          }
        } catch {
          // ignore parse errors
        }
      },
      [userId]
    ),
  });

  // Re-fetch details when dropdown opens
  useEffect(() => {
    if (isOpen) {
      fetchDetails({});
    }
  }, [isOpen]);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsOpen(!isOpen)}
        aria-label={t('center.title')}
        className="relative"
      >
        {isPushSubscribed ? (
          <Bell className="h-5 w-5 text-blue-600 dark:text-blue-400" />
        ) : (
          <Bell className="h-5 w-5" />
        )}
        {totalUnread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        )}
      </Button>

      {isOpen && (
        <div className="fixed right-2 sm:right-4 top-14 w-80 max-w-[calc(100vw-1rem)] bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('center.title')}</h3>
            {sessions.length > 0 && (
              <button
                onClick={() => executeMarkAllRead({})}
                disabled={isMarkingAllRead}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium cursor-pointer disabled:opacity-50"
              >
                {t('center.markAllRead')}
              </button>
            )}
          </div>

          {/* Push notification banner */}
          {isPushSupported && !isPushSubscribed && (
            <div className="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-gray-200 dark:border-gray-700">
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t('center.enablePushBanner')}{' '}
                <Link
                  href="/preferences"
                  className="underline font-medium hover:text-amber-800 dark:hover:text-amber-300"
                  onClick={() => setIsOpen(false)}
                >
                  {t('center.enablePushLink')}
                </Link>
              </p>
            </div>
          )}

          {/* Session list */}
          <div className="max-h-80 overflow-y-auto">
            {isLoadingDetails && sessions.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-300 border-t-gray-600 mx-auto" />
              </div>
            ) : sessions.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                {t('center.noUnread')}
              </div>
            ) : (
              sessions.map((session) => {
                const status = getUnifiedStatus(
                  session.agentStatus as AgentStatus | undefined,
                  session.instanceStatus as InstanceStatus | undefined
                );
                return (
                  <Link
                    key={session.workerId}
                    href={`/sessions/${session.workerId}`}
                    onClick={() => setIsOpen(false)}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-b border-gray-100 dark:border-gray-700/50 last:border-b-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${status.color}`} />
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {session.title || session.workerId}
                        </p>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 ml-3">
                        {session.unreadCount > 0
                          ? t('center.unreadCount', { count: session.unreadCount })
                          : session.hasPending
                            ? t('center.pending')
                            : ''}
                      </p>
                    </div>
                    <span className="flex-shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center">
                      {session.unreadCount > 0 ? session.unreadCount : '!'}
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
