import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('./ddb', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
}));

import { batchWriteWithRetry } from './batch-write-retry';

describe('batchWriteWithRetry', () => {
  beforeEach(() => {
    mockSend.mockReset();
    vi.useFakeTimers();
  });

  test('succeeds immediately when no UnprocessedItems returned', async () => {
    mockSend.mockResolvedValue({ UnprocessedItems: {} });

    const items = [{ DeleteRequest: { Key: { PK: 'a', SK: 'b' } } }];
    await batchWriteWithRetry(items);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0].input;
    expect(input.RequestItems.TestTable).toHaveLength(1);
  });

  test('retries UnprocessedItems with exponential backoff until success', async () => {
    const item1 = { DeleteRequest: { Key: { PK: 'a', SK: '1' } } };
    const item2 = { DeleteRequest: { Key: { PK: 'a', SK: '2' } } };

    mockSend
      .mockResolvedValueOnce({
        UnprocessedItems: { TestTable: [item2] },
      })
      .mockResolvedValueOnce({
        UnprocessedItems: { TestTable: [item2] },
      })
      .mockResolvedValueOnce({
        UnprocessedItems: {},
      });

    vi.useRealTimers();
    await batchWriteWithRetry([item1, item2]);

    expect(mockSend).toHaveBeenCalledTimes(3);
    const lastInput = mockSend.mock.calls[2][0].input;
    expect(lastInput.RequestItems.TestTable).toEqual([item2]);
  });

  test('throws after exceeding max retries with remaining UnprocessedItems', async () => {
    const item = { DeleteRequest: { Key: { PK: 'a', SK: '1' } } };

    mockSend.mockResolvedValue({
      UnprocessedItems: { TestTable: [item] },
    });

    vi.useRealTimers();
    await expect(batchWriteWithRetry([item])).rejects.toThrow(/failed after.*attempts.*1 unprocessed/i);

    expect(mockSend).toHaveBeenCalledTimes(7); // initial + 6 retries
  }, 30000);

  test('handles empty items array without calling DDB', async () => {
    await batchWriteWithRetry([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('re-submits only the unprocessed subset on retry', async () => {
    const item1 = { DeleteRequest: { Key: { PK: 'a', SK: '1' } } };
    const item2 = { DeleteRequest: { Key: { PK: 'a', SK: '2' } } };
    const item3 = { DeleteRequest: { Key: { PK: 'a', SK: '3' } } };

    mockSend
      .mockResolvedValueOnce({
        UnprocessedItems: { TestTable: [item2, item3] },
      })
      .mockResolvedValueOnce({
        UnprocessedItems: { TestTable: [item3] },
      })
      .mockResolvedValueOnce({
        UnprocessedItems: {},
      });

    vi.useRealTimers();
    await batchWriteWithRetry([item1, item2, item3]);

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(mockSend.mock.calls[0][0].input.RequestItems.TestTable).toHaveLength(3);
    expect(mockSend.mock.calls[1][0].input.RequestItems.TestTable).toHaveLength(2);
    expect(mockSend.mock.calls[2][0].input.RequestItems.TestTable).toHaveLength(1);
  });
});
