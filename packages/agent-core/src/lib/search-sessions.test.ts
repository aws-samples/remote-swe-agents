import { describe, expect, test, vi, beforeEach } from 'vitest';

vi.mock('./aws/ddb', () => ({
  ddb: { send: vi.fn() },
  TableName: 'TestTable',
}));

vi.mock('./sessions', () => ({
  getSession: vi.fn(),
  getDescendantSessions: vi.fn(),
  getAllSessionsIncludingChildren: vi.fn(),
}));

vi.mock('./messages', () => ({
  getConversationHistory: vi.fn(),
}));

import {
  extractTextFromContent,
  extractSnippet,
  sortAndTruncate,
  searchSessionContent,
  SEARCHABLE_MESSAGE_TYPES,
  MSG_TOOLS,
} from './search-sessions';
import { getSession, getDescendantSessions, getAllSessionsIncludingChildren } from './sessions';
import { getConversationHistory } from './messages';

const mockedGetSession = vi.mocked(getSession);
const mockedGetDescendantSessions = vi.mocked(getDescendantSessions);
const mockedGetAllSessions = vi.mocked(getAllSessionsIncludingChildren);
const mockedGetHistory = vi.mocked(getConversationHistory);

function makeItem(content: string, sk: string, messageType = 'assistant', role = 'assistant') {
  return { PK: `message-sess1` as const, SK: sk, content, role, tokenCount: 100, messageType };
}

describe('extractTextFromContent', () => {
  test('extracts text blocks', () => {
    const content = [{ text: 'Hello world' }, { text: 'More text' }];
    expect(extractTextFromContent(content, 'assistant')).toBe('Hello world More text');
  });

  test('extracts toolUse.input.message for MSG_TOOLS only when messageType is toolUse', () => {
    const content = [{ toolUse: { name: 'sendMessageToUser', input: { message: 'Hi user' }, toolUseId: '1' } }];
    expect(extractTextFromContent(content, 'toolUse')).toBe('Hi user');
  });

  test('ignores non-MSG_TOOLS in toolUse messageType', () => {
    const content = [{ toolUse: { name: 'executeCommand', input: { message: 'cmd' }, toolUseId: '1' } }];
    expect(extractTextFromContent(content, 'toolUse')).toBe('');
  });

  test('extracts toolUse.input.message for any tool in non-toolUse messageType', () => {
    const content = [{ toolUse: { name: 'anyTool', input: { message: 'msg' }, toolUseId: '1' } }];
    expect(extractTextFromContent(content, 'assistant')).toBe('msg');
  });
});

describe('extractSnippet', () => {
  test('returns null on no match', () => {
    expect(extractSnippet('Hello world', 'xyz')).toBeNull();
  });

  test('case-insensitive match', () => {
    const result = extractSnippet('Hello World', 'hello');
    expect(result).not.toBeNull();
    expect(result!.snippet).toContain('Hello World');
  });

  test('adds ellipsis for long text', () => {
    const text = 'A'.repeat(100) + 'MATCH' + 'B'.repeat(100);
    const result = extractSnippet(text, 'MATCH');
    expect(result!.snippet.startsWith('…')).toBe(true);
    expect(result!.snippet.endsWith('…')).toBe(true);
  });
});

describe('sortAndTruncate', () => {
  test('sorts by timestamp desc and truncates', () => {
    const items = [{ timestamp: 1 }, { timestamp: 3 }, { timestamp: 2 }];
    const result = sortAndTruncate(items, 2);
    expect(result).toEqual([{ timestamp: 3 }, { timestamp: 2 }]);
  });
});

describe('searchSessionContent', () => {
  beforeEach(() => vi.clearAllMocks());

  test('returns empty for empty query', async () => {
    const result = await searchSessionContent({ query: '', scope: 'session', sessionId: 's1' });
    expect(result.results).toHaveLength(0);
  });

  test('throws when sessionId missing for scope=session', async () => {
    await expect(searchSessionContent({ query: 'test', scope: 'session' })).rejects.toThrow('sessionId is required');
  });

  test('throws when sessionId missing for scope=tree', async () => {
    await expect(searchSessionContent({ query: 'test', scope: 'tree' })).rejects.toThrow('sessionId is required');
  });

  test('scope=session searches single session', async () => {
    mockedGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 's1',
      workerId: 's1',
      title: 'Test',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      LSI1: '001700000000000',
      initialMessage: 'hi',
      instanceStatus: 'running',
      sessionCost: 0,
      agentStatus: 'working',
    });
    mockedGetHistory.mockResolvedValue({
      items: [
        makeItem(JSON.stringify([{ text: 'hello foo world' }]), '001700000000001'),
        makeItem(JSON.stringify([{ text: 'no match' }]), '001700000000002'),
      ],
      slackUserId: undefined,
    });

    const result = await searchSessionContent({ query: 'foo', scope: 'session', sessionId: 's1' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].snippet).toContain('foo');
    expect(result.totalSessions).toBe(1);
  });

  test('scope=tree searches parent and descendants', async () => {
    mockedGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 'p1',
      workerId: 'p1',
      title: 'Parent',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      LSI1: '001700000000000',
      initialMessage: 'hi',
      instanceStatus: 'running',
      sessionCost: 0,
      agentStatus: 'working',
    });
    mockedGetDescendantSessions.mockResolvedValue([
      {
        PK: 'sessions',
        SK: 'c1',
        workerId: 'c1',
        title: 'Child',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        LSI1: '001700000000000',
        initialMessage: 'hi',
        instanceStatus: 'running',
        sessionCost: 0,
        agentStatus: 'working',
        parentSessionId: 'p1',
      },
    ]);

    let call = 0;
    mockedGetHistory.mockImplementation(async () => {
      call++;
      if (call === 1)
        return {
          items: [makeItem(JSON.stringify([{ text: 'keyword here' }]), '001700000000001')],
          slackUserId: undefined,
        };
      return {
        items: [makeItem(JSON.stringify([{ text: 'keyword there' }]), '001700000000010')],
        slackUserId: undefined,
      };
    });

    const result = await searchSessionContent({ query: 'keyword', scope: 'tree', sessionId: 'p1' });
    expect(result.results).toHaveLength(2);
    expect(result.totalSessions).toBe(2);
  });

  test('respects maxResults', async () => {
    mockedGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 's1',
      workerId: 's1',
      title: 'Test',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      LSI1: '001700000000000',
      initialMessage: 'hi',
      instanceStatus: 'running',
      sessionCost: 0,
      agentStatus: 'working',
    });
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem(JSON.stringify([{ text: `keyword ${i}` }]), String(1700000000000 + i).padStart(15, '0'))
    );
    mockedGetHistory.mockResolvedValue({ items, slackUserId: undefined });

    const result = await searchSessionContent({ query: 'keyword', scope: 'session', sessionId: 's1', maxResults: 3 });
    expect(result.results).toHaveLength(3);
  });

  test('filters out non-searchable message types', async () => {
    mockedGetSession.mockResolvedValue({
      PK: 'sessions',
      SK: 's1',
      workerId: 's1',
      title: 'Test',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      LSI1: '001700000000000',
      initialMessage: 'hi',
      instanceStatus: 'running',
      sessionCost: 0,
      agentStatus: 'working',
    });
    mockedGetHistory.mockResolvedValue({
      items: [
        makeItem(JSON.stringify([{ text: 'keyword real' }]), '001700000000001', 'assistant'),
        makeItem(JSON.stringify([{ text: 'keyword internal' }]), '001700000000002', 'internalError'),
        makeItem(JSON.stringify([{ text: 'keyword retrigger' }]), '001700000000003', 'systemRetrigger'),
      ],
      slackUserId: undefined,
    });

    const result = await searchSessionContent({ query: 'keyword', scope: 'session', sessionId: 's1' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].messageType).toBe('assistant');
  });
});
