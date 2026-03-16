'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Plus,
  MessageSquare,
  Clock,
  DollarSign,
  Users,
  EyeOff,
  ArrowUpDown,
  EyeOff as EyeOffIcon,
  MoreVertical,
  Trash2,
  Check,
  Circle,
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
import { hideSessionAction, deleteSessionAction, updateAgentStatusFromListAction } from '../actions';
import { extractUserMessage } from '@/lib/message-formatter';
import { toast } from 'sonner';

type SortKey = 'createdAt' | 'updatedAt' | 'sessionCost';
type SortOrder = 'desc' | 'asc';

interface SessionsListProps {
  initialSessions: SessionItem[];
  currentUserId: string;
}

export default function SessionsList({ initialSessions, currentUserId }: SessionsListProps) {
  const t = useTranslations('sessions');
  const router = useRouter();
  const locale = useLocale();
  const localeForDate = locale === 'ja' ? 'ja-JP' : 'en-US';
  const [sessions, setSessions] = useState<SessionItem[]>(initialSessions);
  const [showHideButton, setShowHideButton] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [hideCompleted, setHideCompleted] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const { execute: hideSession } = useAction(hideSessionAction, {
    onSuccess: (data) => {
      router.refresh();
    },
    onError: (error) => {
      console.error('Failed to hide session:', error);
    },
  });

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey) {
        setShowHideButton(true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!event.shiftKey) {
        setShowHideButton(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const handleHideSession = useCallback(
    (event: React.MouseEvent, workerId: string) => {
      event.preventDefault();
      event.stopPropagation();
      hideSession({ workerId });
    },
    [hideSession]
  );

  // Persist sort/filter preferences in localStorage
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

  const sortedSessions = useMemo(() => {
    let filtered = sessions;
    if (hideCompleted) {
      filtered = filtered.filter((s) => s.agentStatus !== 'completed');
    }
    return [...filtered].sort((a, b) => {
      const aVal = a[sortKey] ?? 0;
      const bVal = b[sortKey] ?? 0;
      return sortOrder === 'desc' ? Number(bVal) - Number(aVal) : Number(aVal) - Number(bVal);
    });
  }, [sessions, sortKey, sortOrder, hideCompleted]);

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
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
        {sortedSessions.map((session) => {
          const status = getUnifiedStatus(session.agentStatus, session.instanceStatus);
          const isOtherUserSession = session.initiator && session.initiator !== `webapp#${currentUserId}`;
          return (
            <div key={session.workerId} className="relative">
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
                    <MessageSquare className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate flex-1">
                      {session.title || session.SK}
                    </h3>
                  </div>

                  <p className="text-xs text-gray-600 dark:text-gray-300 mb-4 flex-1 truncate">
                    {extractUserMessage(session.initialMessage)}
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
                        {new Date(session.updatedAt).toLocaleDateString(localeForDate)}{' '}
                        {new Date(session.updatedAt).toLocaleTimeString(localeForDate, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>

              {/* 3-dot menu */}
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
                      {t('deleteSession')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          );
        })}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTargetId} onOpenChange={(open) => !open && setDeleteTargetId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteSession')}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteSessionConfirm')}</AlertDialogDescription>
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
