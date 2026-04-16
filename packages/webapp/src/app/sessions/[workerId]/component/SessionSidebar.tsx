'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { MessageSquare, Plus, X, List, CheckCheck } from 'lucide-react';
import { SessionItem, webappEventSchema } from '@remote-swe-agents/agent-core/schema';
import { getUnifiedStatus } from '@/utils/session-status';
import { useTranslations } from 'next-intl';
import { useEventBus } from '@/hooks/use-event-bus';
import { useRouter } from 'next/navigation';
import type { UnreadMap } from '@remote-swe-agents/agent-core/lib';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

type SortKey = 'createdAt' | 'updatedAt' | 'lastMessageAt' | 'sessionCost';
type SortOrder = 'desc' | 'asc';

function hasWorkingDescendant(parentId: string, childrenMap: Record<string, SessionItem[]>): boolean {
  const children = childrenMap[parentId];
  if (!children) return false;
  for (const child of children) {
    if (child.agentStatus === 'working') return true;
    if (hasWorkingDescendant(child.workerId, childrenMap)) return true;
  }
  return false;
}

interface SessionSidebarProps {
  currentWorkerId: string;
  sessions: SessionItem[];
  isOpen: boolean;
  onClose: () => void;
  unreadMap?: UnreadMap;
  userId: string;
  onUnreadUpdate?: (workerId: string, data: { unreadCount: number; hasPending: boolean }) => void;
  onMarkAllRead?: () => void;
  isMarkingAllRead?: boolean;
}

export default function SessionSidebar({
  currentWorkerId,
  sessions: initialSessions,
  isOpen,
  onClose,
  unreadMap = {},
  userId,
  onUnreadUpdate,
  onMarkAllRead,
  isMarkingAllRead,
}: SessionSidebarProps) {
  const t = useTranslations('sessions');
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionItem[]>(initialSessions);
  const navRef = useRef<HTMLElement>(null);
  const [navHeight, setNavHeight] = useState(0);
  const scrollYRef = useRef(0);
  const [sortKey, setSortKey] = useState<SortKey>('lastMessageAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Sync sort settings from localStorage (shared with session list page)
  useEffect(() => {
    const savedSortKey = localStorage.getItem('sessions-sort-key') as SortKey | null;
    const savedSortOrder = localStorage.getItem('sessions-sort-order') as SortOrder | null;
    if (savedSortKey) setSortKey(savedSortKey);
    if (savedSortOrder) setSortOrder(savedSortOrder);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'sessions-sort-key' && e.newValue) {
        setSortKey(e.newValue as SortKey);
      }
      if (e.key === 'sessions-sort-order' && e.newValue) {
        setSortOrder(e.newValue as SortOrder);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

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
    onReceived: useCallback(
      (payload: unknown) => {
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
          if (event.type === 'unreadUpdate') {
            if (event.userId !== userId) return;
            onUnreadUpdate?.(event.workerId, { unreadCount: event.unreadCount, hasPending: event.hasPending });
          }
        } catch (error) {
          console.error('Failed to parse webapp event:', error);
        }
      },
      [router, currentWorkerId, userId, onUnreadUpdate]
    ),
  });

  const sortedSessions = useMemo(() => {
    return [...sessions]
      .filter((session) => session.agentStatus !== 'completed' || session.workerId === currentWorkerId)
      .sort((a, b) => {
        let aVal: number;
        let bVal: number;
        if (sortKey === 'lastMessageAt') {
          aVal = a.lastMessageAt ?? a.updatedAt ?? 0;
          bVal = b.lastMessageAt ?? b.updatedAt ?? 0;
        } else {
          aVal = Number(a[sortKey] ?? 0);
          bVal = Number(b[sortKey] ?? 0);
        }
        return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      });
  }, [sessions, sortKey, sortOrder]);

  // Build parent-child map for sidebar grouping
  const childrenMap = useMemo(() => {
    const map: Record<string, SessionItem[]> = {};
    for (const session of sortedSessions) {
      if (session.parentSessionId) {
        if (!map[session.parentSessionId]) {
          map[session.parentSessionId] = [];
        }
        map[session.parentSessionId].push(session);
      }
    }
    return map;
  }, [sortedSessions]);

  const rootSessions = useMemo(() => {
    return sortedSessions.filter((s) => !s.parentSessionId);
  }, [sortedSessions]);

  // Auto-expand: show descendants of the current session and its ancestor chain
  const expandedGroupIds = useMemo(() => {
    const set = new Set<string>();
    // Walk up the ancestor chain from the current session
    let current = sortedSessions.find((s) => s.workerId === currentWorkerId);
    while (current) {
      if (current.parentSessionId) {
        set.add(current.parentSessionId);
        current = sortedSessions.find((s) => s.workerId === current!.parentSessionId);
      } else {
        break;
      }
    }
    // Also expand current session and all its descendants
    const expandDescendants = (id: string) => {
      if (childrenMap[id]?.length) {
        set.add(id);
        for (const child of childrenMap[id]) {
          expandDescendants(child.workerId);
        }
      }
    };
    expandDescendants(currentWorkerId);
    return set;
  }, [currentWorkerId, sortedSessions, childrenMap]);

  const renderChildren = (children: SessionItem[], depth: number) => {
    const paddingLeft = 6 + depth * 4; // pl-10, pl-14, pl-18, etc.
    return children.map((child) => {
      const childStatus = getUnifiedStatus(child.agentStatus, child.instanceStatus);
      const isChildCurrent = child.workerId === currentWorkerId;
      const grandchildren = childrenMap[child.workerId] ?? [];
      const hasGrandchildren = grandchildren.length > 0;
      const isChildExpanded = expandedGroupIds.has(child.workerId);
      return (
        <div key={child.workerId}>
          <Link
            href={`/sessions/${child.workerId}`}
            onClick={onClose}
            className={`flex items-center gap-2 pr-3 py-2 mx-1 rounded-md transition-colors text-left`}
            style={{ paddingLeft: `${paddingLeft * 4}px` }}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${childStatus.color} ${
                isChildCurrent ? '' : ''
              }`}
            />
            <span
              className={`text-xs truncate flex-1 ${
                isChildCurrent
                  ? 'text-blue-700 dark:text-blue-300 font-semibold'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {child.title || child.SK}
            </span>
            {unreadMap[child.workerId]?.unreadCount > 0 && (
              <span className="flex-shrink-0 min-w-4 h-4 px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center">
                {unreadMap[child.workerId].unreadCount}
              </span>
            )}
          </Link>
          {hasGrandchildren && isChildExpanded && renderChildren(grandchildren, depth + 1)}
        </div>
      );
    });
  };

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
            {Object.values(unreadMap).some((v) => v.unreadCount > 0) && onMarkAllRead && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={onMarkAllRead}
                      disabled={isMarkingAllRead}
                      className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <CheckCheck className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('markAllRead')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
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
            {rootSessions.map((session) => {
              const hasWorkingChild = hasWorkingDescendant(session.workerId, childrenMap);
              const status =
                hasWorkingChild && session.agentStatus !== 'working'
                  ? getUnifiedStatus('working', session.instanceStatus)
                  : getUnifiedStatus(session.agentStatus, session.instanceStatus);
              const isCurrent = session.workerId === currentWorkerId;
              const children = childrenMap[session.workerId] ?? [];
              const hasChildren = children.length > 0;
              const isExpanded = expandedGroupIds.has(session.workerId);
              return (
                <div key={session.workerId}>
                  <div className="flex items-center mx-1">
                    <Link
                      href={`/sessions/${session.workerId}`}
                      onClick={onClose}
                      className={`flex items-center gap-2.5 px-2 py-2.5 rounded-md transition-colors text-left flex-1 min-w-0 ${
                        isCurrent
                          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                      }`}
                    >
                      <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${status.color}`} />
                      <span className="text-sm truncate flex-1">{session.title || session.SK}</span>
                      {unreadMap[session.workerId]?.unreadCount > 0 && (
                        <span className="flex-shrink-0 min-w-4 h-4 px-1 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center">
                          {unreadMap[session.workerId].unreadCount}
                        </span>
                      )}
                    </Link>
                  </div>
                  {hasChildren && isExpanded && renderChildren(children, 1)}
                </div>
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
