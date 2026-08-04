'use client';

import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { searchSessionContentAction, type SearchResult } from '../actions';
import { usePathname, useRouter } from 'next/navigation';

interface SessionContentSearchProps {
  workerId: string;
  sidebarOpen?: boolean;
}

function HighlightedSnippet({
  snippet,
  matchOffset,
  queryLength,
}: {
  snippet: string;
  matchOffset: number;
  queryLength: number;
}) {
  if (matchOffset < 0 || matchOffset >= snippet.length) {
    return <span className="text-sm text-gray-600 dark:text-gray-300">{snippet}</span>;
  }
  const before = snippet.slice(0, matchOffset);
  const match = snippet.slice(matchOffset, matchOffset + queryLength);
  const after = snippet.slice(matchOffset + queryLength);
  return (
    <span className="text-sm text-gray-600 dark:text-gray-300 break-words">
      {before}
      <mark className="bg-yellow-200 dark:bg-yellow-700 text-gray-900 dark:text-white rounded-sm px-0.5">{match}</mark>
      {after}
    </span>
  );
}

export default function SessionContentSearch({ workerId, sidebarOpen }: SessionContentSearchProps) {
  const t = useTranslations('sessions');
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (sidebarOpen && isOpen) {
      setIsOpen(false);
    }
  }, [sidebarOpen, isOpen]);

  const { execute, isExecuting } = useAction(searchSessionContentAction, {
    onSuccess: ({ data }) => {
      if (data) {
        setResults(data.results);
        setTimedOut(data.timedOut ?? false);
        setError(null);
      }
    },
    onError: (err) => {
      setError(err.error?.serverError || t('searchError'));
      setResults(null);
      setTimedOut(false);
    },
  });

  const handleSearch = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed || isExecuting) return;
    setSubmittedQuery(trimmed);
    setError(null);
    setResults(null);
    setTimedOut(false);
    execute({ workerId, query: trimmed });
  }, [query, workerId, execute, isExecuting]);

  const handleClear = useCallback(() => {
    setQuery('');
    setSubmittedQuery('');
    setResults(null);
    setError(null);
    setTimedOut(false);
    inputRef.current?.focus();
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    toggleRef.current?.focus();
  }, []);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSearch();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (query || results || error) {
          handleClear();
        } else {
          handleClose();
        }
      }
    },
    [handleSearch, handleClear, handleClose, query, results, error]
  );

  const handleResultClick = useCallback(
    (resultSessionId: string, messageSK: string) => {
      const targetPath = `/sessions/${resultSessionId}`;
      const hash = `#msg-${messageSK}`;
      setIsOpen(false);
      if (pathname === targetPath) {
        if (window.location.hash === hash) {
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } else {
          window.location.hash = hash;
        }
      } else {
        router.push(`${targetPath}${hash}`);
      }
    },
    [pathname, router]
  );

  useEffect(() => {
    if (!isOpen) return;

    function handleGlobalKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (e.target === inputRef.current) return;
        e.preventDefault();
        handleClose();
      }
    }

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(target) &&
        toggleRef.current &&
        !toggleRef.current.contains(target)
      ) {
        handleClose();
      }
    }

    document.addEventListener('keydown', handleGlobalKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, handleClose]);

  useLayoutEffect(() => {
    if (!isOpen || !toggleRef.current) return;
    function updatePosition() {
      if (!toggleRef.current) return;
      const rect = toggleRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const panelWidth = Math.min(384, viewportWidth - 32);
      let left = rect.right - panelWidth;
      if (left < 16) left = 16;
      if (left + panelWidth > viewportWidth - 16) {
        left = viewportWidth - panelWidth - 16;
      }
      setPanelStyle({
        position: 'fixed',
        top: rect.bottom + 8,
        left,
        width: panelWidth,
      });
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

  const panel =
    isOpen && mounted
      ? createPortal(
          <div
            ref={panelRef}
            id="search-content-panel"
            role="dialog"
            aria-label={t('searchContent')}
            style={panelStyle}
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50"
          >
            <div className="p-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500 pointer-events-none" />
                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleInputKeyDown}
                    placeholder={t('searchContentPlaceholder')}
                    aria-label={t('searchContent')}
                    aria-describedby={error ? 'search-error' : undefined}
                    className="w-full pl-9 pr-8 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {query && !isExecuting && (
                    <button
                      onClick={handleClear}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      aria-label={t('clearFilter')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                  {isExecuting && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400">
                      <Loader2 className="w-4 h-4 animate-spin" />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {error && (
              <div
                id="search-error"
                role="alert"
                className="mx-3 mb-3 flex items-center gap-2 p-2 rounded-md bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1">{error}</span>
                <button
                  onClick={handleSearch}
                  className="flex items-center gap-1 text-sm font-medium hover:underline"
                  aria-label={t('searchRetry')}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t('searchRetry')}
                </button>
              </div>
            )}

            {results !== null && !error && (
              <div
                className="border-t border-gray-200 dark:border-gray-700 max-h-80 overflow-y-auto"
                role="region"
                aria-label={t('searchResults')}
              >
                {results.length === 0 ? (
                  <div className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">{t('searchNoResults')}</div>
                ) : (
                  <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                    {results.map((result) => (
                      <li key={`${result.sessionId}-${result.messageId}`}>
                        <button
                          type="button"
                          onClick={() => handleResultClick(result.sessionId, result.messageSK)}
                          className="block w-full text-left p-3 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium text-blue-600 dark:text-blue-400 truncate max-w-[200px]">
                              {result.sessionTitle}
                            </span>
                            <span className="text-xs text-gray-400 dark:text-gray-500">
                              {new Date(result.timestamp).toLocaleString()}
                            </span>
                          </div>
                          <HighlightedSnippet
                            snippet={result.snippet}
                            matchOffset={result.matchOffset}
                            queryLength={submittedQuery.length}
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {results.length > 0 && (
                  <div className="p-2 text-center text-xs text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-700">
                    {timedOut && <div className="text-amber-500 dark:text-amber-400 mb-1">{t('searchTimedOut')}</div>}
                    {t('searchResultCount', { count: results.length })}
                  </div>
                )}
              </div>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={toggleRef}
        onClick={() => {
          if (isOpen) {
            handleClose();
          } else {
            setIsOpen(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        className={`inline-flex items-center justify-center w-8 h-8 sm:w-10 sm:h-10 rounded-md border cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
          isOpen
            ? 'border-blue-500 dark:border-blue-400 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/50'
            : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600'
        }`}
        aria-label={isOpen ? t('closeSearch') : t('searchContent')}
        title={isOpen ? t('closeSearch') : t('searchContent')}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? 'search-content-panel' : undefined}
      >
        <Search className="w-4 h-4" />
      </button>
      {panel}
    </>
  );
}
