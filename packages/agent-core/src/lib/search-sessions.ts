import { getSession, getDescendantSessions, getAllSessionsIncludingChildren } from './sessions';
import { getConversationHistory } from './messages';
import type { SessionItem } from '../schema';

export type SearchScope = 'session' | 'tree' | 'all';

export interface SearchSessionsInput {
  query: string;
  scope: SearchScope;
  sessionId?: string;
  maxResults?: number;
  timeoutMs?: number;
  concurrencyLimit?: number;
}

export interface SearchHit {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  messageSK: string;
  snippet: string;
  matchOffset: number;
  role: string;
  messageType: string;
  timestamp: number;
}

export interface SearchSessionsOutput {
  results: SearchHit[];
  totalSessions: number;
  timedOut: boolean;
  warning?: string;
}

const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const SNIPPET_RADIUS = 80;
const MAX_SESSIONS_FOR_ALL_SCOPE = 500;

export const SEARCHABLE_MESSAGE_TYPES = new Set([
  'userMessage',
  'assistant',
  'toolUse',
  'agentMessage',
  'eventTrigger',
  'communicationLog',
]);

export const MSG_TOOLS = new Set([
  'sendMessageToUser',
  'sendMessageToUserIfNecessary',
  'sendImageToUser',
  'sendFileToUser',
]);

export function extractTextFromContent(content: any[], messageType: string): string {
  if (messageType === 'toolUse') {
    return content
      .map((block: any) => {
        if (block.toolUse && MSG_TOOLS.has(block.toolUse.name)) {
          return block.toolUse.input?.message ?? '';
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return content
    .map((block: any) => {
      if (block.text) return block.text;
      if (block.toolUse?.input?.message) return block.toolUse.input.message;
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

export function extractSnippet(
  textContent: string,
  query: string,
  snippetRadius = SNIPPET_RADIUS
): { snippet: string; matchOffset: number } | null {
  const textLower = textContent.toLowerCase();
  const queryLower = query.toLowerCase();
  const matchIdx = textLower.indexOf(queryLower);
  if (matchIdx === -1) return null;

  const start = Math.max(0, matchIdx - snippetRadius);
  const end = Math.min(textContent.length, matchIdx + query.length + snippetRadius);
  let snippet = textContent.slice(start, end);
  let offset = matchIdx - start;
  if (start > 0) {
    snippet = '…' + snippet;
    offset += 1;
  }
  if (end < textContent.length) {
    snippet = snippet + '…';
  }

  return { snippet, matchOffset: offset };
}

export function sortAndTruncate<T extends { timestamp: number }>(results: T[], maxResults: number): T[] {
  return [...results].sort((a, b) => b.timestamp - a.timestamp).slice(0, maxResults);
}

async function searchSingleSession(
  sid: string,
  sessionTitle: string,
  query: string,
  snippetRadius: number
): Promise<SearchHit[]> {
  const { items } = await getConversationHistory(sid);
  const localResults: SearchHit[] = [];

  for (const item of items) {
    if (!SEARCHABLE_MESSAGE_TYPES.has(item.messageType)) continue;

    let textContent = '';
    try {
      const content = JSON.parse(item.content);
      if (Array.isArray(content)) {
        textContent = extractTextFromContent(content, item.messageType);
      }
    } catch {
      continue;
    }

    const match = extractSnippet(textContent, query, snippetRadius);
    if (!match) continue;

    localResults.push({
      sessionId: sid,
      sessionTitle,
      messageId: item.SK,
      messageSK: item.SK,
      snippet: match.snippet,
      matchOffset: match.matchOffset,
      role: item.role,
      messageType: item.messageType,
      timestamp: parseInt(item.SK),
    });
  }

  return localResults;
}

export async function searchSessionContent(input: SearchSessionsInput): Promise<SearchSessionsOutput> {
  const {
    query,
    scope,
    sessionId,
    maxResults = DEFAULT_MAX_RESULTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrencyLimit = DEFAULT_CONCURRENCY,
  } = input;

  if (!query || query.trim().length === 0) {
    return { results: [], totalSessions: 0, timedOut: false };
  }

  let targetSessions: { id: string; title: string }[] = [];
  let warning: string | undefined;

  switch (scope) {
    case 'session': {
      if (!sessionId) {
        throw new Error('sessionId is required for scope=session');
      }
      const session = await getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }
      targetSessions = [{ id: sessionId, title: session.title || sessionId }];
      break;
    }
    case 'tree': {
      if (!sessionId) {
        throw new Error('sessionId is required for scope=tree');
      }
      const rootSession = await getSession(sessionId);
      if (!rootSession) {
        throw new Error('Session not found');
      }
      const descendants = await getDescendantSessions(sessionId);
      targetSessions = [
        { id: sessionId, title: rootSession.title || sessionId },
        ...descendants.map((s: SessionItem) => ({ id: s.workerId, title: s.title || s.workerId })),
      ];
      break;
    }
    case 'all': {
      const allSessions = await getAllSessionsIncludingChildren();
      if (allSessions.length > MAX_SESSIONS_FOR_ALL_SCOPE) {
        const sorted = allSessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        targetSessions = sorted
          .slice(0, MAX_SESSIONS_FOR_ALL_SCOPE)
          .map((s: SessionItem) => ({ id: s.workerId, title: s.title || s.workerId }));
        warning = `Search limited to the most recent ${MAX_SESSIONS_FOR_ALL_SCOPE} sessions (total: ${allSessions.length}).`;
      } else {
        targetSessions = allSessions.map((s: SessionItem) => ({ id: s.workerId, title: s.title || s.workerId }));
      }
      break;
    }
  }

  const allResults: SearchHit[] = [];
  let timedOut = false;
  const deadline = Date.now() + timeoutMs;

  const queue = [...targetSessions];
  let idx = 0;
  const runNext = async (): Promise<void> => {
    while (idx < queue.length && !timedOut) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      const i = idx++;
      const session = queue[i];
      try {
        const results = await searchSingleSession(session.id, session.title, query, SNIPPET_RADIUS);
        allResults.push(...results);
      } catch {
        // Skip failed sessions
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrencyLimit, targetSessions.length) }, () => runNext());
  await Promise.all(workers);

  const results = sortAndTruncate(allResults, maxResults);

  return {
    results,
    totalSessions: targetSessions.length,
    timedOut,
    ...(warning ? { warning } : {}),
  };
}
