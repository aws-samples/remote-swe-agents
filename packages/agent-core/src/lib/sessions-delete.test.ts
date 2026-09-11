import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockBatchWriteWithRetry = vi.fn();
const mockPaginateQuery = vi.fn();

vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
  batchWriteWithRetry: (...args: any[]) => mockBatchWriteWithRetry(...args),
}));

vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
  const original = await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>();
  return {
    ...original,
    paginateQuery: (...args: any[]) => mockPaginateQuery(...args),
  };
});

vi.mock('./event-triggers', () => ({ deleteAllEventTriggers: vi.fn() }));
vi.mock('./unread', () => ({ deleteUnreadByWorkerId: vi.fn() }));

import { deleteSession } from './sessions';

function asyncIterableOf<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    },
  };
}

describe('deleteSession', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockBatchWriteWithRetry.mockReset();
    mockPaginateQuery.mockReset();
    mockBatchWriteWithRetry.mockResolvedValue(undefined);
  });

  test('uses batchWriteWithRetry for message and metadata deletion', async () => {
    // First paginateQuery call: getAllSessionsIncludingChildren (no children)
    // Then per prefix: message-worker-1, metadata-worker-1
    mockPaginateQuery
      .mockReturnValueOnce(asyncIterableOf([{ Items: [] }])) // sessions
      .mockReturnValueOnce(
        asyncIterableOf([
          {
            Items: [
              { PK: 'message-worker-1', SK: '001' },
              { PK: 'message-worker-1', SK: '002' },
            ],
          },
        ])
      ) // messages
      .mockReturnValueOnce(asyncIterableOf([{ Items: [] }])); // metadata

    mockSend.mockResolvedValue({}); // DeleteCommand for session

    await deleteSession('worker-1');

    expect(mockBatchWriteWithRetry).toHaveBeenCalledTimes(1);
    expect(mockBatchWriteWithRetry).toHaveBeenCalledWith([
      { DeleteRequest: { Key: { PK: 'message-worker-1', SK: '001' } } },
      { DeleteRequest: { Key: { PK: 'message-worker-1', SK: '002' } } },
    ]);
  });

  test('deletes descendant sessions before the parent', async () => {
    const deletedSessions: string[] = [];

    // getAllSessionsIncludingChildren returns parent + child
    mockPaginateQuery.mockImplementation((_config: any, input: any) => {
      const pk = input?.ExpressionAttributeValues?.[':pk'];
      if (pk === 'sessions') {
        return asyncIterableOf([
          {
            Items: [
              { PK: 'sessions', SK: 'parent-1', workerId: 'parent-1' },
              { PK: 'sessions', SK: 'child-1', workerId: 'child-1', parentSessionId: 'parent-1' },
            ],
          },
        ]);
      }
      return asyncIterableOf([{ Items: [] }]);
    });

    mockSend.mockImplementation((cmd: any) => {
      if (cmd?.input?.Key?.PK === 'sessions') {
        deletedSessions.push(cmd.input.Key.SK);
      }
      return Promise.resolve({});
    });

    await deleteSession('parent-1');

    expect(deletedSessions).toEqual(['child-1', 'parent-1']);
  });

  test('batches items in groups of 25 for batchWriteWithRetry', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      PK: 'message-worker-1',
      SK: String(i).padStart(3, '0'),
    }));

    mockPaginateQuery.mockImplementation((_config: any, input: any) => {
      const pk = input?.ExpressionAttributeValues?.[':pk'];
      if (pk === 'sessions') {
        return asyncIterableOf([{ Items: [] }]);
      }
      if (pk?.startsWith('message-')) {
        return asyncIterableOf([{ Items: items }]);
      }
      return asyncIterableOf([{ Items: [] }]);
    });

    mockSend.mockResolvedValue({});

    await deleteSession('worker-1');

    expect(mockBatchWriteWithRetry).toHaveBeenCalledTimes(2);
    expect(mockBatchWriteWithRetry.mock.calls[0][0]).toHaveLength(25);
    expect(mockBatchWriteWithRetry.mock.calls[1][0]).toHaveLength(5);
  });
});
