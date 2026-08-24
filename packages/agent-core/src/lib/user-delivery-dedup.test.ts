import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { MessageItem } from '../schema';

const mockGetRecentMessages = vi.fn();
const mockSend = vi.fn();

vi.mock('./messages', () => ({
  getRecentMessages: (...args: any[]) => mockGetRecentMessages(...args),
}));

vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
}));

import {
  shouldSuppressUserDelivery,
  recordUserDelivery,
  USER_DELIVERY_LOG_MESSAGE_TYPE,
  isMessageDeliveryToolName,
  shouldSuppressToolUseRedelivery,
} from './user-delivery-dedup';

const LONG =
  'Starting the deploy now. First I will check the CDK stacks, enumerate the changes, and apply them in order. I will report on every diff as it comes up, so no need to worry.';

const deliveryLogItem = (text: string, sk: number): MessageItem =>
  ({
    PK: 'message-w1',
    SK: String(sk).padStart(15, '0'),
    content: JSON.stringify([{ text }]),
    role: 'assistant',
    tokenCount: 0,
    messageType: USER_DELIVERY_LOG_MESSAGE_TYPE,
  }) as MessageItem;

describe('shouldSuppressUserDelivery', () => {
  beforeEach(() => {
    mockGetRecentMessages.mockReset();
  });

  test('suppresses an exact re-emit inside the window', async () => {
    const now = 1_000_000;
    mockGetRecentMessages.mockResolvedValue([deliveryLogItem(LONG, now - 1000)]);
    expect(await shouldSuppressUserDelivery('w1', LONG, now)).toBe(true);
  });

  test('does NOT suppress when no recent delivery log exists', async () => {
    const now = 1_000_000;
    mockGetRecentMessages.mockResolvedValue([]);
    expect(await shouldSuppressUserDelivery('w1', LONG, now)).toBe(false);
  });

  test('never suppresses a short message even if identical', async () => {
    const now = 1_000_000;
    const short = 'got it';
    mockGetRecentMessages.mockResolvedValue([deliveryLogItem(short, now - 1000)]);
    expect(await shouldSuppressUserDelivery('w1', short, now)).toBe(false);
  });

  test('short-circuits BEFORE the DynamoDB lookup for short messages', async () => {
    const now = 1_000_000;
    expect(await shouldSuppressUserDelivery('w1', 'got it', now)).toBe(false);
    // The DDB read must be skipped entirely for sub-MIN_DEDUP_LENGTH messages.
    expect(mockGetRecentMessages).not.toHaveBeenCalled();
  });

  test('does NOT suppress a genuinely different long message', async () => {
    const now = 1_000_000;
    mockGetRecentMessages.mockResolvedValue([deliveryLogItem(LONG, now - 1000)]);
    const different =
      'Investigation finished: root cause was an expired auth token during the nightly sync. Patched the refresh logic, added a regression case, and reran the full pipeline.';
    expect(await shouldSuppressUserDelivery('w1', different, now)).toBe(false);
  });

  test('ignores delivery log entries older than the window', async () => {
    const now = 10_000_000;
    const windowMs = 5 * 60 * 1000;
    mockGetRecentMessages.mockResolvedValue([deliveryLogItem(LONG, now - windowMs - 1)]);
    expect(await shouldSuppressUserDelivery('w1', LONG, now, windowMs)).toBe(false);
  });

  test('only considers userDeliveryLog rows, not other message types', async () => {
    const now = 1_000_000;
    const other = {
      ...deliveryLogItem(LONG, now - 1000),
      messageType: 'assistant',
    } as MessageItem;
    mockGetRecentMessages.mockResolvedValue([other]);
    expect(await shouldSuppressUserDelivery('w1', LONG, now)).toBe(false);
  });

  test('biases toward DELIVERING when the lookup throws (best-effort)', async () => {
    const now = 1_000_000;
    mockGetRecentMessages.mockRejectedValue(new Error('ddb down'));
    expect(await shouldSuppressUserDelivery('w1', LONG, now)).toBe(false);
  });
});

describe('recordUserDelivery', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  test('persists a userDeliveryLog item with the delivered text', async () => {
    await recordUserDelivery('w1', LONG, 1_234_567);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const putArg = mockSend.mock.calls[0][0];
    const item = putArg.input.Item as MessageItem;
    expect(item.PK).toBe('message-w1');
    expect(item.SK).toBe(String(1_234_567).padStart(15, '0'));
    expect(item.messageType).toBe(USER_DELIVERY_LOG_MESSAGE_TYPE);
    expect(JSON.parse(item.content)).toEqual([{ text: LONG }]);
  });

  test('sets a DynamoDB TTL roughly 1 hour out (seconds)', async () => {
    const now = 1_700_000_000_000; // ms
    await recordUserDelivery('w1', LONG, now);
    const item = mockSend.mock.calls[0][0].input.Item as MessageItem;
    expect(item.TTL).toBe(Math.floor(now / 1000) + 60 * 60);
  });

  test('swallows persist errors (best-effort, never breaks delivery)', async () => {
    mockSend.mockRejectedValue(new Error('ddb down'));
    await expect(recordUserDelivery('w1', LONG)).resolves.toBeUndefined();
  });
});

const toolUseItem = (toolName: string, message: string | undefined, sk: number): MessageItem =>
  ({
    PK: 'message-w1',
    SK: String(sk).padStart(15, '0'),
    content: JSON.stringify([{ toolUse: { toolUseId: `t${sk}`, name: toolName, input: { message } } }]),
    role: 'assistant',
    tokenCount: 0,
    messageType: 'toolUse',
  }) as MessageItem;

describe('isMessageDeliveryToolName', () => {
  test('matches the user-facing message-delivery tools', () => {
    expect(isMessageDeliveryToolName('sendMessageToUser')).toBe(true);
    expect(isMessageDeliveryToolName('sendMessageToUserIfNecessary')).toBe(true);
    expect(isMessageDeliveryToolName('sendImageToUser')).toBe(true);
    expect(isMessageDeliveryToolName('sendFileToUser')).toBe(true);
  });

  test('does NOT match other tools (no friendly fire)', () => {
    expect(isMessageDeliveryToolName('sendMessageToAgent')).toBe(false);
    expect(isMessageDeliveryToolName('fs_read')).toBe(false);
    expect(isMessageDeliveryToolName('executeCommand')).toBe(false);
    expect(isMessageDeliveryToolName('think')).toBe(false);
    expect(isMessageDeliveryToolName(undefined)).toBe(false);
    expect(isMessageDeliveryToolName('')).toBe(false);
  });
});

describe('shouldSuppressToolUseRedelivery', () => {
  beforeEach(() => {
    mockGetRecentMessages.mockReset();
  });

  test('suppresses a re-delivery matching a prior sendMessageToUser toolUse', async () => {
    const now = 1_000_000;
    mockGetRecentMessages.mockResolvedValue([toolUseItem('sendMessageToUser', LONG, now - 1000)]);
    expect(await shouldSuppressToolUseRedelivery('w1', LONG, now)).toBe(true);
  });

  test('does NOT suppress the FIRST delivery (no prior toolUse in window)', async () => {
    const now = 1_000_000;
    mockGetRecentMessages.mockResolvedValue([]);
    expect(await shouldSuppressToolUseRedelivery('w1', LONG, now)).toBe(false);
  });

  test('only considers message-delivery toolUse items, not other tools', async () => {
    const now = 1_000_000;
    // A non-delivery tool whose input happens to carry the same message text
    // must never count as a prior delivery.
    mockGetRecentMessages.mockResolvedValue([toolUseItem('executeCommand', LONG, now - 1000)]);
    expect(await shouldSuppressToolUseRedelivery('w1', LONG, now)).toBe(false);
  });

  test('does NOT suppress a genuinely different delivery message', async () => {
    const now = 1_000_000;
    mockGetRecentMessages.mockResolvedValue([toolUseItem('sendMessageToUser', LONG, now - 1000)]);
    const different =
      'Investigation finished: root cause was an expired auth token during the nightly sync. Patched the refresh logic, added a regression case, and reran the full pipeline.';
    expect(await shouldSuppressToolUseRedelivery('w1', different, now)).toBe(false);
  });

  test('never suppresses a short message + short-circuits the DDB lookup', async () => {
    const now = 1_000_000;
    expect(await shouldSuppressToolUseRedelivery('w1', 'got it', now)).toBe(false);
    expect(mockGetRecentMessages).not.toHaveBeenCalled();
  });

  test('ignores delivery toolUse older than the window', async () => {
    const now = 10_000_000;
    const windowMs = 5 * 60 * 1000;
    mockGetRecentMessages.mockResolvedValue([toolUseItem('sendMessageToUser', LONG, now - windowMs - 1)]);
    expect(await shouldSuppressToolUseRedelivery('w1', LONG, now, windowMs)).toBe(false);
  });

  test('fail-open: lookup throwing -> NOT suppressed (persist/emit proceeds)', async () => {
    const now = 1_000_000;
    mockGetRecentMessages.mockRejectedValue(new Error('ddb down'));
    expect(await shouldSuppressToolUseRedelivery('w1', LONG, now)).toBe(false);
  });
});
