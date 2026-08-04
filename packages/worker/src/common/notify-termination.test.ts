import { describe, expect, test, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(async () => undefined as unknown),
  sendAgentMessage: vi.fn(async () => undefined),
  incrementUnread: vi.fn(async () => undefined),
  sendPushNotificationToUser: vi.fn(async () => undefined),
}));

vi.mock('@remote-swe-agents/agent-core/lib', async () => {
  const actual = await vi.importActual<typeof import('@remote-swe-agents/agent-core/lib')>(
    '@remote-swe-agents/agent-core/lib'
  );
  return {
    ...actual,
    getSession: mocks.getSession,
    sendAgentMessage: mocks.sendAgentMessage,
    incrementUnread: mocks.incrementUnread,
    sendPushNotificationToUser: mocks.sendPushNotificationToUser,
  };
});

const { notifyTermination } = await import('./notify-termination');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifyTermination', () => {
  describe('child session (parentSessionId set)', () => {
    test('error → sendAgentMessage to parent with [Child error] tag', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        parentSessionId: 'p1',
        initiator: 'webapp#user-x',
      });
      await notifyTermination('w1', 'error', 'boom');

      expect(mocks.sendAgentMessage).toHaveBeenCalledTimes(1);
      const call = (mocks.sendAgentMessage.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(call.senderWorkerId).toBe('w1');
      expect(call.targetSessionIds).toEqual(['p1']);
      expect(call.message).toContain('[Child error]');
      expect(call.message).toContain('boom');

      expect(mocks.incrementUnread).not.toHaveBeenCalled();
      expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
    });

    test('sleeping → sendAgentMessage to parent with [Child sleeping] tag and acknowledge=true', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        parentSessionId: 'p1',
        initiator: 'webapp#user-x',
      });
      await notifyTermination('w1', 'sleeping', '');

      expect(mocks.sendAgentMessage).toHaveBeenCalledTimes(1);
      const call = (mocks.sendAgentMessage.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(call.message).toContain('[Child sleeping]');
      expect(call.acknowledge).toBe(true);

      expect(mocks.incrementUnread).not.toHaveBeenCalled();
      expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
    });

    test('error → sendAgentMessage with acknowledge falsy (wakes parent)', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        parentSessionId: 'p1',
        initiator: 'webapp#user-x',
      });
      await notifyTermination('w1', 'error', 'crash');

      const call = (mocks.sendAgentMessage.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(call.acknowledge).toBeFalsy();
    });
  });

  describe('top-level webapp# session', () => {
    test('error → incrementUnread + sendPushNotificationToUser', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        initiator: 'webapp#user-abc',
        title: 'My Session',
      });
      await notifyTermination('w1', 'error', 'oops');

      expect(mocks.incrementUnread).toHaveBeenCalledWith('user-abc', 'w1');
      expect(mocks.sendPushNotificationToUser).toHaveBeenCalledTimes(1);
      const [userId, payload] = mocks.sendPushNotificationToUser.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(userId).toBe('user-abc');
      expect(payload.title).toBe('[Error] My Session');
      expect(payload.body).toContain('oops');
      expect(payload.url).toBe('/sessions/w1');
      expect(payload.workerId).toBe('w1');

      expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
    });

    test('error without title falls back to workerId', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        initiator: 'webapp#user-abc',
      });
      await notifyTermination('w1', 'error', 'oops');

      const [, payload] = mocks.sendPushNotificationToUser.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(payload.title).toBe('[Error] w1');
    });

    test('sleeping → no-op (no push, no unread bump)', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        initiator: 'webapp#user-abc',
        title: 'My Session',
      });
      await notifyTermination('w1', 'sleeping', '');

      expect(mocks.incrementUnread).not.toHaveBeenCalled();
      expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
      expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
    });

    test('long error reason is truncated', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        initiator: 'webapp#user-abc',
      });
      const longReason = 'x'.repeat(500);
      await notifyTermination('w1', 'error', longReason);

      const [, payload] = mocks.sendPushNotificationToUser.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect((payload.body as string).length).toBeLessThanOrEqual(200);
    });
  });

  describe('top-level slack# session', () => {
    test('error → no-op (slack thread already received the message)', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        initiator: 'slack#U999',
      });
      await notifyTermination('w1', 'error', 'oops');

      expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
      expect(mocks.incrementUnread).not.toHaveBeenCalled();
      expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
    });

    test('sleeping → no-op', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        initiator: 'slack#U999',
      });
      await notifyTermination('w1', 'sleeping', '');

      expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
      expect(mocks.incrementUnread).not.toHaveBeenCalled();
      expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
    });
  });

  describe('defensive paths', () => {
    test('unknown initiator → log warning, no-op', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        initiator: 'cron#daily',
      });

      await notifyTermination('w1', 'error', 'oops');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
      expect(mocks.incrementUnread).not.toHaveBeenCalled();
      expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('missing initiator → log warning, no-op', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mocks.getSession.mockResolvedValue({ workerId: 'w1' });

      await notifyTermination('w1', 'error', 'oops');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('missing session → silent no-op', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mocks.getSession.mockResolvedValue(undefined);

      await notifyTermination('w1', 'error', 'oops');

      expect(warnSpy).not.toHaveBeenCalled();
      expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('downstream throw is swallowed (never re-throws)', async () => {
      mocks.getSession.mockResolvedValue({
        workerId: 'w1',
        parentSessionId: 'p1',
        initiator: 'webapp#user-x',
      });
      mocks.sendAgentMessage.mockRejectedValueOnce(new Error('network down'));

      await expect(notifyTermination('w1', 'error', 'oops')).resolves.toBeUndefined();
    });
  });
});
