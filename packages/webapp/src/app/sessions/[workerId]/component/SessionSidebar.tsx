'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { MessageSquare, Plus, X, List } from 'lucide-react';
import { SessionItem, webappEventSchema } from '@remote-swe-agents/agent-core/schema';
import { getUnifiedStatus } from '@/utils/session-status';
import { useTranslations } from 'next-intl';
import { useEventBus } from '@/hooks/use-event-bus';
import { useRouter } from 'next/navigation';

interface SessionSidebarProps {
  currentWorkerId: string;
  sessions: SessionItem[];
  isOpen: boolean;
  onClose: () => void;
}

export default function SessionSidebar({
  currentWorkerId,
  sessions: initialSessions,
  isOpen,
  onClose,
}: SessionSidebarProps) {
  const t = useTranslations('sessions');
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionItem[]>(initialSessions);
  const navRef = useRef<HTMLElement>(null);
  const [navHeight, setNavHeight] = useState(0);
  const scrollYRef = useRef(0);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setNavHeight(entries[0].contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setSessions(initialSessions);
  }, [initialSessions]);

  useEffect(() => {
    if (isOpen) {
      scrollYRef.current = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollYRef.current}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overflow = '';
      window.scrollTo(0, scrollYRef.current);
    }
    return () => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  useEventBus({
    channelName: 'webapp/worker/*',
    onReceived: useCallback((payload: unknown) => {
      try {
        const event = webappEventSchema.parse(payload);
        if (event.type === 'agentStatusUpdate' || event.type === 'instanceStatusChanged') {
          setSessions((prev) => {
            if (!prev.some((s) => s.workerId === event.workerId)) {
              router.refresh();
              return prev;
            }
            return prev.map((session) => {
              if (session.workerId === event.workerId) {
                return {
                  ...session,
                  agentStatus: event.type === 'agentStatusUpdate' ? event.status : session.agentStatus,
                  instanceStatus: event.type === 'instanceStatusChanged' ? event.status : session.instanceStatus,
                  updatedAt: Date.now(),
                };
              }
              return session;
            });
          });
        }
        if (event.type === 'sessionTitleUpdate') {
          setSessions((prev) => {
            if (!prev.some((s) => s.workerId === event.workerId)) {
              router.refresh();
              return prev;
            }
            return prev.map((session) => {
              if (session.workerId === event.workerId) {
                return { ...session, title: event.newTitle };
              }
              return session;
            });
          });
        }
        if (event.type === 'lastMessageUpdate') {
          setSessions((prev) => {
            if (!prev.some((s) => s.workerId === event.workerId)) {
              router.refresh();
              return prev;
            }
            return prev.map((session) => {
              if (session.workerId === event.workerId) {
                return {
                  ...session,
                  lastMessage: event.lastMessage,
                  lastMessageAt: event.lastMessageAt ?? event.timestamp,
                };
              }
              return session;
            });
          });
        }
      } catch (error) {
        console.error('Failed to parse webapp event:', error);
      }
    }, [router]),
  });

  const sortedSessions = useMemo(() => {
    return [...sessions]
      .filter((session) => session.agentStatus !== 'completed')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [sessions]);

  return (
    <>
      {/* Overlay for mobile */}
      {isOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 h-full z-50 w-72 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col transition-transform duration-300 ease-in-out
          lg:sticky lg:top-0 lg:h-screen lg:z-auto lg:translate-x-0
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{t('title')}</h2>
          <div className="flex items-center gap-1">
            <Link
              href="/sessions/new"
              className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors"
              title={t('newSession')}
            >
              <Plus className="w-4 h-4" />
            </Link>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors lg:hidden cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Session list (exclude completed, sorted by updatedAt desc) */}
        <nav
          ref={navRef}
          className="flex-1 overflow-y-scroll overscroll-auto"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <div className="py-1" style={{ minHeight: navHeight > 0 ? navHeight + 1 : undefined }}>
            {sortedSessions.map((session) => {
              const status = getUnifiedStatus(session.agentStatus, session.instanceStatus);
              const isCurrent = session.workerId === currentWorkerId;
              return (
                <Link
                  key={session.workerId}
                  href={`/sessions/${session.workerId}`}
                  onClick={onClose}
                  className={`flex items-center gap-2.5 px-3 py-2.5 mx-1 rounded-md transition-colors text-left ${
                    isCurrent
                      ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${status.color}`} />
                  <span className="text-sm truncate flex-1">{session.title || session.SK}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Bottom link to full sessions list */}
        <div className="border-t border-gray-200 dark:border-gray-700 p-2">
          <Link
            href="/sessions"
            className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <List className="w-4 h-4" />
            {t('goToSessionList')}
          </Link>
        </div>
      </aside>
    </>
  );
}
