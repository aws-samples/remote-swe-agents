'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Plus,
  MessageSquare,
  Clock,
  DollarSign,
  Users,
  ArrowUpDown,
  EyeOff as EyeOffIcon,
  MoreVertical,
  Trash2,
  Check,
  Circle,
  CheckSquare,
  Square,
  X,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useEventBus } from '@/hooks/use-event-bus';
import { useCallback, useState, useEffect, useMemo } from 'react';
import { SessionItem, webappEventSchema } from '@remote-swe-agents/agent-core/schema';
import { getUnifiedStatus } from '@/utils/session-status';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useAction } from 'next-safe-action/hooks';
import { deleteSessionAction, batchDeleteSessionsAction, updateAgentStatusFromListAction } from '../actions';
import { extractUserMessage } from '@/lib/message-formatter';
import { formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';
import type { UnreadMap } from '@remote-swe-agents/agent-core/lib';

type SortKey = 'createdAt' | 'updatedAt' | 'lastMessageAt' | 'sessionCost';
type SortOrder = 'desc' | 'asc';

interface SessionsListProps {
  initialSessions: SessionItem[];
  currentUserId: string;
  unreadMap?: UnreadMap;
}

export default function SessionsList({ initialSessions, currentUserId, unreadMap = {} }: SessionsListProps) {
  const t = useTranslations('sessions');
  const router = useRouter();
  const locale = useLocale();
  const localeForDate = locale === 'ja' ? 'ja-JP' : 'en-US';
  const [sessions, setSessions] = useState<SessionItem[]>(initialSessions);
  const [sortKey, setSortKey] = useState<SortKey>('lastMessageAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [hideCompleted, setHideCompleted] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteDialog, setShowBatchDeleteDialog] = useState(false);
  const { execute: executeDeleteSession } = useAction(deleteSessionAction, {
    onSuccess: () => {
      toast.success(t('deleteSessionSuccess'));
      router.refresh();
    },
    onError: (error) => {
      console.error('Failed to delete session:', error);
      toast.error(t('deleteSessionError'));
    },
  });

  const { execute: executeUpdateStatus } = useAction(updateAgentStatusFromListAction, {
    onSuccess: () => {
      router.refresh();
    },
    onError: (error) => {
      console.error('Failed to update status:', error);
    },
  });

  const { execute: executeBatchDelete, isExecuting: isBatchDeleting } = useAction(batchDeleteSessionsAction, {
    onSuccess: ({ data }) => {
      toast.success(t('batchDeleteSuccess', { count: data?.count ?? 0 }));
      setSelectMode(false);
      setSelectedIds(new Set());
      router.refresh();
    },
    onError: (error) => {
      console.error('Failed to batch delete sessions:', error);
      toast.error(t('batchDeleteError'));
    },
  });

  useEventBus({
    channelName: 'webapp/worker/*',
    onReceived: useCallback(
      (payload: unknown) => {
        try {
          const event = webappEventSchema.parse(payload);
          console.log(`received: `, event);

          if (event.type === 'agentStatusUpdate' || event.type === 'instanceStatusChanged') {
            if (sessions.some((s) => s.workerId == event.workerId)) {
              setSessions((prevSessions) =>
                prevSessions.map((session) => {
                  if (session.workerId === event.workerId) {
                    return {
                      ...session,
                      agentStatus: event.type === 'agentStatusUpdate' ? event.status : session.agentStatus,
                      instanceStatus: event.type === 'instanceStatusChanged' ? event.status : session.instanceStatus,
                    };
                  }
                  return session;
                })
              );
            } else {
              // if there is inconsistency, refresh
              router.refresh();
            }
          }
          if (event.type == 'sessionTitleUpdate') {
            if (sessions.some((s) => s.workerId == event.workerId)) {
              setSessions((prevSessions) =>
                prevSessions.map((session) => {
                  if (session.workerId === event.workerId) {
                    return {
                      ...session,
                      title: event.newTitle,
                    };
                  }
                  return session;
                })
              );
            }
          }
          if (event.type == 'lastMessageUpdate') {
            if (sessions.some((s) => s.workerId == event.workerId)) {
              setSessions((prevSessions) =>
                prevSessions.map((session) => {
                  if (session.workerId === event.workerId) {
                    return {
                      ...session,
                      lastMessage: event.lastMessage,
                      lastMessageAt: event.lastMessageAt ?? event.timestamp,
                    };
                  }
                  return session;
                })
              );
            }
          }
        } catch (error) {
          console.error('Failed to parse webapp event:', error);
        }
      },
      [router]
    ),
  });

  useEffect(() => {
    setSessions(initialSessions);
  }, [initialSessions]);

  // Persist hideCompleted preference in localStorage
  useEffect(() => {
    const saved = localStorage.getItem('sessions-hide-completed');
    if (saved !== null) {
      setHideCompleted(saved === 'true');
    }
    const savedSortKey = localStorage.getItem('sessions-sort-key') as SortKey | null;
    const savedSortOrder = localStorage.getItem('sessions-sort-order') as SortOrder | null;
    if (savedSortKey) setSortKey(savedSortKey);
    if (savedSortOrder) setSortOrder(savedSortOrder);
  }, []);

  const handleSortKeyChange = useCallback((newSortKey: SortKey) => {
    setSortKey(newSortKey);
    localStorage.setItem('sessions-sort-key', newSortKey);
  }, []);

  const handleSortOrderToggle = useCallback(() => {
    setSortOrder((prev) => {
      const next = prev === 'desc' ? 'asc' : 'desc';
      localStorage.setItem('sessions-sort-order', next);
      return next;
    });
  }, []);

  const handleHideCompletedToggle = useCallback(() => {
    setHideCompleted((prev) => {
      const next = !prev;
      localStorage.setItem('sessions-hide-completed', String(next));
      return next;
    });
  }, []);

  const toggleSelectMode = useCallback(() => {
    setSelectMode((prev) => {
      if (prev) {
        setSelectedIds(new Set());
      }
      return !prev;
    });
  }, []);

  const toggleSelection = useCallback((workerId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(workerId)) {
        next.delete(workerId);
      } else {
        next.add(workerId);
      }
      return next;
    });
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Build a map of parentSessionId -> child sessions
  const childrenMap = useMemo(() => {
    const map: Record<string, SessionItem[]> = {};
    for (const session of sessions) {
      if (session.parentSessionId) {
        if (!map[session.parentSessionId]) {
          map[session.parentSessionId] = [];
        }
        map[session.parentSessionId].push(session);
      }
    }
    return map;
  }, [sessions]);

  const sortedSessions = useMemo(() => {
    // Only show root sessions (no parentSessionId) at the top level
    let filtered = sessions.filter((s) => !s.parentSessionId);
    if (hideCompleted) {
      filtered = filtered.filter((s) => s.agentStatus !== 'completed');
    }
    return [...filtered].sort((a, b) => {
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
  }, [sessions, sortKey, sortOrder, hideCompleted]);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(sortedSessions.map((s) => s.workerId)));
  }, [sortedSessions]);

  return (
    <>
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('aiAgentSessions')}</h1>
        <Link href="/sessions/new">
          <Button className="flex items-center gap-2">
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">{t('newSession')}</span>
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex items-center gap-2">
          <ArrowUpDown className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <select
            className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={sortKey}
            onChange={(e) => handleSortKeyChange(e.target.value as SortKey)}
          >
            <option value="lastMessageAt">{t('sortByLastMessageAt')}</option>
            <option value="updatedAt">{t('sortByUpdatedAt')}</option>
            <option value="createdAt">{t('sortByCreatedAt')}</option>
            <option value="sessionCost">{t('sortByCost')}</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={handleSortOrderToggle}
            title={sortOrder === 'desc' ? t('sortDesc') : t('sortAsc')}
          >
            <span className="text-xs">{sortOrder === 'desc' ? '↓' : '↑'}</span>
          </Button>
        </div>

        <Button
          variant={hideCompleted ? 'default' : 'outline'}
          size="sm"
          className="h-8 flex items-center gap-1.5"
          onClick={handleHideCompletedToggle}
        >
          <EyeOffIcon className="w-3.5 h-3.5" />
          <span className="text-xs">{t('hideCompleted')}</span>
        </Button>

        <Button
          variant={selectMode ? 'default' : 'outline'}
          size="sm"
          className="h-8 flex items-center gap-1.5"
          onClick={toggleSelectMode}
        >
          <CheckSquare className="w-3.5 h-3.5" />
          <span className="text-xs">{t('selectMode')}</span>
        </Button>
      </div>

      {selectMode && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Button variant="outline" size="sm" className="h-8" onClick={selectAll}>
            <span className="text-xs">{t('selectAll')}</span>
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={deselectAll}>
            <span className="text-xs">{t('deselectAll')}</span>
          </Button>
          {selectedIds.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              className="h-8 flex items-center gap-1.5"
              onClick={() => setShowBatchDeleteDialog(true)}
              disabled={isBatchDeleting}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="text-xs">{t('deleteSelected', { count: selectedIds.size })}</span>
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-8" onClick={toggleSelectMode}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
        {sortedSessions.map((session) => {
          const status = getUnifiedStatus(session.agentStatus, session.instanceStatus);
          const isOtherUserSession = session.initiator && session.initiator !== `webapp#${currentUserId}`;
          const isSelected = selectedIds.has(session.workerId);
          const hasChildren = (childrenMap[session.workerId] ?? []).length > 0;
          return (
            <div key={session.workerId} className="relative">
              {selectMode ? (
                <div onClick={() => toggleSelection(session.workerId)} className="block cursor-pointer">
                  <div
                    className={`border-2 ${isSelected ? 'border-blue-500 dark:border-blue-400' : 'border-gray-200 dark:border-gray-700'} ${session.agentStatus === 'completed' ? 'bg-gray-100 dark:bg-gray-900' : 'bg-white dark:bg-gray-800'} rounded-lg p-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex flex-col h-40 relative`}
                  >
                    <div className="absolute top-2 left-2">
                      {isSelected ? (
                        <CheckSquare className="w-5 h-5 text-blue-500 dark:text-blue-400" />
                      ) : (
                        <Square className="w-5 h-5 text-gray-400 dark:text-gray-500" />
                      )}
                    </div>

                    {isOtherUserSession && (
                      <div className="absolute bottom-2 right-2" title={t('initiatedByOtherUsers')}>
                        <Users className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                      </div>
                    )}

                    <div className="flex items-center gap-2 mb-3 pl-6">
                      <div className="relative flex-shrink-0">
                        <MessageSquare className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                      </div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate flex-1">
                        {session.title || session.SK}
                      </h3>
                    </div>

                    <p className="text-xs text-gray-600 dark:text-gray-300 mb-4 flex-1 truncate">
                      {session.lastMessage || extractUserMessage(session.initialMessage)}
                    </p>

                    <div className="space-y-2 text-xs text-gray-500 dark:text-gray-400">
                      <div className="flex items-center">
                        <div className="w-4 flex justify-center">
                          <span className={`inline-block w-2 h-2 rounded-full ${status.color}`} />
                        </div>
                        <span className="truncate ml-1">{t(status.i18nKey)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <Link href={`/sessions/${session.workerId}`} className="block">
                  <div
                    className={`border border-gray-200 dark:border-gray-700 ${session.agentStatus === 'completed' ? 'bg-gray-100 dark:bg-gray-900' : 'bg-white dark:bg-gray-800'} rounded-lg p-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex flex-col h-40 relative`}
                  >
                    {isOtherUserSession && (
                      <div className="absolute bottom-2 right-2" title={t('initiatedByOtherUsers')}>
                        <Users className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                      </div>
                    )}

                    <div className="flex items-center gap-2 mb-3">
                      <div className="relative flex-shrink-0">
                        <MessageSquare className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                        {unreadMap[session.workerId]?.unreadCount > 0 && (
                          <span className="absolute -top-1.5 -right-1.5 min-w-3.5 h-3.5 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                            {unreadMap[session.workerId].unreadCount}
                          </span>
                        )}
                      </div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate flex-1">
                        {session.title || session.SK}
                      </h3>
                    </div>

                    <p className="text-xs text-gray-600 dark:text-gray-300 mb-4 flex-1 truncate">
                      {session.lastMessage || extractUserMessage(session.initialMessage)}
                    </p>

                    <div className="space-y-2 text-xs text-gray-500 dark:text-gray-400">
                      <div className="flex items-center">
                        <div className="w-4 flex justify-center">
                          <span className={`inline-block w-2 h-2 rounded-full ${status.color}`} />
                        </div>
                        <span className="truncate ml-1">{t(status.i18nKey)}</span>
                      </div>

                      <div className="flex items-center">
                        <div className="w-4 flex justify-center">
                          <DollarSign className="w-3 h-3" />
                        </div>
                        <span className="ml-1">{(session.sessionCost ?? 0).toFixed(2)}</span>
                      </div>

                      <div className="flex items-center">
                        <div className="w-4 flex justify-center">
                          <Clock className="w-3 h-3" />
                        </div>
                        <span className="truncate ml-1">
                          {formatDateTime(new Date(session.updatedAt), localeForDate)}
                        </span>
                      </div>
                    </div>
                  </div>
                </Link>
              )}

              {/* 3-dot menu */}
              {!selectMode && (
                <div className="absolute top-2 right-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors cursor-pointer"
                        onClick={(e) => e.preventDefault()}
                      >
                        <MoreVertical className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem
                        onClick={() =>
                          executeUpdateStatus({
                            workerId: session.workerId,
                            status: session.agentStatus === 'completed' ? 'pending' : 'completed',
                          })
                        }
                        className="cursor-pointer"
                      >
                        {session.agentStatus === 'completed' ? (
                          <>
                            <Circle className="w-4 h-4 mr-2" />
                            {t('markAsIncomplete')}
                          </>
                        ) : (
                          <>
                            <Check className="w-4 h-4 mr-2" />
                            {t('markAsCompleted')}
                          </>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setDeleteTargetId(session.workerId)}
                        className="cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        {hasChildren ? t('deleteGroup') : t('deleteSession')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTargetId} onOpenChange={(open) => !open && setDeleteTargetId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteSession')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargetId && (childrenMap[deleteTargetId]?.length ?? 0) > 0
                ? t('deleteGroupConfirm', { count: childrenMap[deleteTargetId].length })
                : t('deleteSessionConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (deleteTargetId) {
                  executeDeleteSession({ workerId: deleteTargetId });
                  setDeleteTargetId(null);
                }
              }}
            >
              {t('deleteSession')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Batch delete confirmation dialog */}
      <AlertDialog open={showBatchDeleteDialog} onOpenChange={(open) => !open && setShowBatchDeleteDialog(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('batchDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('batchDeleteConfirm', { count: selectedIds.size })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                executeBatchDelete({ workerIds: Array.from(selectedIds) });
                setShowBatchDeleteDialog(false);
              }}
            >
              {t('deleteSelected', { count: selectedIds.size })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {sortedSessions.length === 0 && (
        <div className="text-center py-12">
          <MessageSquare className="w-12 h-12 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">{t('noSessionsFound')}</h3>
          <p className="text-gray-600 dark:text-gray-300 mb-6">{t('createSessionToStart')}</p>
          <Link href="/sessions/new">
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">{t('newSession')}</span>
            </Button>
          </Link>
        </div>
      )}
    </>
  );
}
