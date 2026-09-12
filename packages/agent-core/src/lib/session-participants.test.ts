import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockSendPushNotificationToUser = vi.fn();
const mockIncrementUnread = vi.fn();

vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
}));

vi.mock('./push-notification', () => ({
  sendPushNotificationToUser: (...args: any[]) => mockSendPushNotificationToUser(...args),
}));

vi.mock('./unread', () => ({
  incrementUnread: (...args: any[]) => mockIncrementUnread(...args),
}));

import {
  addSessionParticipant,
  getSessionParticipants,
  notifyOtherParticipants,
  copySessionParticipants,
} from './session-participants';

describe('session-participants', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSendPushNotificationToUser.mockReset();
    mockIncrementUnread.mockReset();
  });

  describe('addSessionParticipant', () => {
    test('adds participant to DDB', async () => {
      mockSend.mockResolvedValue({});
      await addSessionParticipant('worker-123', 'user-abc');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const putCmd = mockSend.mock.calls[0][0];
      expect(putCmd.input.Item.PK).toBe('session-participants-worker-123');
      expect(putCmd.input.Item.SK).toBe('user-abc');
      expect(putCmd.input.ConditionExpression).toBe('attribute_not_exists(SK)');
    });

    test('silently ignores ConditionalCheckFailedException (already participant)', async () => {
      const error = new Error('Conditional check failed');
      (error as any).name = 'ConditionalCheckFailedException';
      mockSend.mockRejectedValue(error);

      await expect(addSessionParticipant('worker-123', 'user-abc')).resolves.toBeUndefined();
    });

    test('re-throws other errors', async () => {
      const error = new Error('DDB unavailable');
      (error as any).name = 'InternalServerError';
      mockSend.mockRejectedValue(error);

      await expect(addSessionParticipant('worker-123', 'user-abc')).rejects.toThrow('DDB unavailable');
    });
  });

  describe('getSessionParticipants', () => {
    test('returns participant user IDs', async () => {
      mockSend.mockResolvedValue({
        Items: [{ SK: 'user-1' }, { SK: 'user-2' }, { SK: 'user-3' }],
      });

      const result = await getSessionParticipants('worker-123');
      expect(result).toEqual(['user-1', 'user-2', 'user-3']);

      const queryCmd = mockSend.mock.calls[0][0];
      expect(queryCmd.input.KeyConditionExpression).toBe('PK = :pk');
      expect(queryCmd.input.ExpressionAttributeValues[':pk']).toBe('session-participants-worker-123');
    });

    test('returns empty array when no participants', async () => {
      mockSend.mockResolvedValue({ Items: [] });
      const result = await getSessionParticipants('worker-123');
      expect(result).toEqual([]);
    });

    test('returns empty array when Items is undefined', async () => {
      mockSend.mockResolvedValue({});
      const result = await getSessionParticipants('worker-123');
      expect(result).toEqual([]);
    });
  });

  describe('notifyOtherParticipants', () => {
    test('notifies all participants except the sender', async () => {
      // getSessionParticipants call
      mockSend.mockResolvedValue({
        Items: [{ SK: 'user-1' }, { SK: 'user-2' }, { SK: 'user-sender' }],
      });
      mockIncrementUnread.mockResolvedValue(undefined);
      mockSendPushNotificationToUser.mockResolvedValue(undefined);

      await notifyOtherParticipants('worker-123', 'user-sender', {
        title: 'Test Session',
        body: 'Hello world',
      });

      // Should notify user-1 and user-2, but NOT user-sender
      expect(mockIncrementUnread).toHaveBeenCalledTimes(2);
      expect(mockIncrementUnread).toHaveBeenCalledWith('user-1', 'worker-123');
      expect(mockIncrementUnread).toHaveBeenCalledWith('user-2', 'worker-123');

      expect(mockSendPushNotificationToUser).toHaveBeenCalledTimes(2);
      expect(mockSendPushNotificationToUser).toHaveBeenCalledWith('user-1', {
        title: 'Test Session',
        body: 'Hello world',
        url: '/sessions/worker-123',
        workerId: 'worker-123',
      });
      expect(mockSendPushNotificationToUser).toHaveBeenCalledWith('user-2', {
        title: 'Test Session',
        body: 'Hello world',
        url: '/sessions/worker-123',
        workerId: 'worker-123',
      });
    });

    test('does nothing when sender is the only participant', async () => {
      mockSend.mockResolvedValue({
        Items: [{ SK: 'user-sender' }],
      });

      await notifyOtherParticipants('worker-123', 'user-sender', {
        title: 'Test',
        body: 'Hello',
      });

      expect(mockIncrementUnread).not.toHaveBeenCalled();
      expect(mockSendPushNotificationToUser).not.toHaveBeenCalled();
    });

    test('does nothing when no participants exist', async () => {
      mockSend.mockResolvedValue({ Items: [] });

      await notifyOtherParticipants('worker-123', 'user-sender', {
        title: 'Test',
        body: 'Hello',
      });

      expect(mockIncrementUnread).not.toHaveBeenCalled();
      expect(mockSendPushNotificationToUser).not.toHaveBeenCalled();
    });

    test('notifies all participants when senderUserId is undefined (e.g. Slack)', async () => {
      mockSend.mockResolvedValue({
        Items: [{ SK: 'user-1' }, { SK: 'user-2' }],
      });
      mockIncrementUnread.mockResolvedValue(undefined);
      mockSendPushNotificationToUser.mockResolvedValue(undefined);

      await notifyOtherParticipants('worker-123', undefined, {
        title: 'From Slack',
        body: 'Hey there',
      });

      // All participants notified because sender is undefined
      expect(mockIncrementUnread).toHaveBeenCalledTimes(2);
      expect(mockSendPushNotificationToUser).toHaveBeenCalledTimes(2);
    });

    test('continues notifying other recipients when one fails', async () => {
      mockSend.mockResolvedValue({
        Items: [{ SK: 'user-1' }, { SK: 'user-2' }],
      });
      // First user fails, second succeeds
      mockIncrementUnread.mockRejectedValueOnce(new Error('DDB error')).mockResolvedValueOnce(undefined);
      mockSendPushNotificationToUser.mockResolvedValue(undefined);

      // Should not throw - errors are caught per-recipient
      await expect(
        notifyOtherParticipants('worker-123', 'other-user', {
          title: 'Test',
          body: 'Hello',
        })
      ).resolves.toBeUndefined();

      // Both recipients attempted
      expect(mockIncrementUnread).toHaveBeenCalledTimes(2);
    });
  });

  describe('copySessionParticipants', () => {
    test('copies all participants from source to target session', async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [{ SK: 'user-1' }, { SK: 'user-2' }, { SK: 'user-3' }] })
        .mockResolvedValue({});

      await copySessionParticipants('source-session', 'target-session');

      // 1 query + 3 puts
      expect(mockSend).toHaveBeenCalledTimes(4);

      const putCalls = mockSend.mock.calls.slice(1);
      const pks = putCalls.map((call) => call[0].input.Item.PK);
      expect(pks).toEqual([
        'session-participants-target-session',
        'session-participants-target-session',
        'session-participants-target-session',
      ]);
      const sks = putCalls.map((call) => call[0].input.Item.SK);
      expect(sks).toEqual(['user-1', 'user-2', 'user-3']);
    });

    test('does nothing when source has no participants', async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await copySessionParticipants('source-session', 'target-session');

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });
});
