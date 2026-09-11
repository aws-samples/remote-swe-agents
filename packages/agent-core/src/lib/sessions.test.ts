import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockGet = vi.fn();

vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
}));

vi.mock('./event-triggers', () => ({ deleteAllEventTriggers: vi.fn() }));
vi.mock('./unread', () => ({ deleteUnreadByWorkerId: vi.fn() }));

import { reparentSessions, clearSessionKiroSessionId } from './sessions';

function getTransactItems(call: any) {
  return call[0]?.input?.TransactItems;
}

describe('reparentSessions', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockGet.mockReset();
    // getSession uses GetCommand; return the queued item keyed by SK.
    mockSend.mockImplementation((cmd: any) => {
      const sk = cmd?.input?.Key?.SK;
      if (sk !== undefined) return Promise.resolve({ Item: mockGet(sk) });
      return Promise.resolve({});
    });
  });

  test('reparents all given sessions under the new parent in one TransactWrite', async () => {
    mockGet.mockImplementation((sk: string) =>
      sk === 'P2' ? { PK: 'sessions', SK: 'P2', workerId: 'P2' } : undefined
    );

    await reparentSessions('P2', ['P', 'C1', 'C2']);

    const txCall = mockSend.mock.calls.find((c) => getTransactItems(c));
    const items = getTransactItems(txCall);
    expect(items).toHaveLength(3);
    expect(items.map((i: any) => i.Update.Key.SK)).toEqual(['P', 'C1', 'C2']);
    for (const i of items) {
      expect(i.Update.ExpressionAttributeValues[':parentSessionId']).toBe('P2');
      expect(i.Update.ConditionExpression).toBe('attribute_exists(SK)');
    }
  });

  test('rejects self-parent', async () => {
    await expect(reparentSessions('P2', ['P', 'P2'])).rejects.toThrow(/own parent/);
    expect(mockSend.mock.calls.some((c) => getTransactItems(c))).toBe(false);
  });

  test('rejects a cycle (child is an ancestor of the new parent)', async () => {
    // P2's parent is C1 -> reparenting C1 under P2 would create a cycle.
    mockGet.mockImplementation((sk: string) => {
      if (sk === 'P2') return { PK: 'sessions', SK: 'P2', workerId: 'P2', parentSessionId: 'C1' };
      if (sk === 'C1') return { PK: 'sessions', SK: 'C1', workerId: 'C1' };
      return undefined;
    });

    await expect(reparentSessions('P2', ['C1'])).rejects.toThrow(/cycle/);
    expect(mockSend.mock.calls.some((c) => getTransactItems(c))).toBe(false);
  });

  test('no-op for empty list', async () => {
    await reparentSessions('P2', []);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('rejects when a child workerId does not exist (attribute_exists guard)', async () => {
    mockGet.mockImplementation((sk: string) =>
      sk === 'P2' ? { PK: 'sessions', SK: 'P2', workerId: 'P2' } : undefined
    );
    mockSend.mockImplementation((cmd: any) => {
      const sk = cmd?.input?.Key?.SK;
      if (sk !== undefined) return Promise.resolve({ Item: mockGet(sk) });
      // TransactWrite: DynamoDB cancels the tx because attribute_exists(SK) fails.
      return Promise.reject(new Error('TransactionCanceledException: ConditionalCheckFailed'));
    });

    await expect(reparentSessions('P2', ['ghost-session'])).rejects.toThrow(
      /ConditionalCheckFailed|TransactionCanceled/
    );
  });

  test('rejects more than 100 sessions in one call', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `c${i}`);
    await expect(reparentSessions('P2', ids)).rejects.toThrow(/more than 100/);
    expect(mockSend.mock.calls.some((c) => getTransactItems(c))).toBe(false);
  });
});

describe('clearSessionKiroSessionId', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  test('issues REMOVE kiroSessionId + SET updatedAt', async () => {
    mockSend.mockResolvedValueOnce({});
    await clearSessionKiroSessionId('worker-abc');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0]?.input;
    expect(input.TableName).toBe('TestTable');
    expect(input.Key).toEqual({ PK: 'sessions', SK: 'worker-abc' });
    expect(input.UpdateExpression).toContain('REMOVE #kiroSessionId');
    expect(input.UpdateExpression).toContain('SET #updatedAt');
    expect(input.ExpressionAttributeNames['#kiroSessionId']).toBe('kiroSessionId');
    expect(input.ExpressionAttributeNames['#updatedAt']).toBe('updatedAt');
    expect(typeof input.ExpressionAttributeValues[':updatedAt']).toBe('number');
  });

  test('propagates DDB errors', async () => {
    mockSend.mockRejectedValueOnce(new Error('DDB unavailable'));
    await expect(clearSessionKiroSessionId('worker-x')).rejects.toThrow('DDB unavailable');
  });
});
