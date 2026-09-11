import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { resolveToolEventSink, _resetTestEventDropState } from './test-event-drop-hook';
import { defaultToolEventSink } from './default-sink';

vi.mock('../messages', () => ({
  saveToolUseMessage: vi.fn(async () => ({
    PK: 'message-w1',
    SK: '000000000000100',
    content: '[]',
    role: 'assistant',
    tokenCount: 0,
    messageType: 'toolUse',
  })),
  saveToolResultMessage: vi.fn(async () => ({
    PK: 'message-w1',
    SK: '000000000000101',
    content: '[]',
    role: 'user',
    tokenCount: 0,
    messageType: 'toolResult',
  })),
}));

vi.mock('../events', () => ({
  sendWebappEvent: vi.fn(async () => undefined),
}));

const { sendWebappEvent } = await import('../events');

describe('test-event-drop-hook', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetTestEventDropState();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('when REMOTE_SWE_TEST_EVENT_DROP_ENABLED is not set', () => {
    test('resolveToolEventSink returns defaultToolEventSink directly', () => {
      delete process.env.REMOTE_SWE_TEST_EVENT_DROP_ENABLED;
      const sink = resolveToolEventSink();
      expect(sink).toBe(defaultToolEventSink);
    });

    test('no overhead — same object reference as production', () => {
      delete process.env.REMOTE_SWE_TEST_EVENT_DROP_ENABLED;
      const sink1 = resolveToolEventSink();
      const sink2 = resolveToolEventSink();
      expect(sink1).toBe(sink2);
      expect(sink1).toBe(defaultToolEventSink);
    });
  });

  describe('when REMOTE_SWE_TEST_EVENT_DROP_ENABLED is "false"', () => {
    test('returns defaultToolEventSink (not enabled)', () => {
      process.env.REMOTE_SWE_TEST_EVENT_DROP_ENABLED = 'false';
      const sink = resolveToolEventSink();
      expect(sink).toBe(defaultToolEventSink);
    });
  });

  describe('when REMOTE_SWE_TEST_EVENT_DROP_ENABLED is "true"', () => {
    beforeEach(() => {
      process.env.REMOTE_SWE_TEST_EVENT_DROP_ENABLED = 'true';
    });

    test('returns a different sink (wrapped)', () => {
      const sink = resolveToolEventSink();
      expect(sink).not.toBe(defaultToolEventSink);
    });

    test('logs a warning on first call', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      resolveToolEventSink();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[TEST-EVENT-DROP-HOOK] WARNING'));
      warnSpy.mockRestore();
    });

    test('logs warning only once across multiple calls', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      resolveToolEventSink();
      resolveToolEventSink();
      resolveToolEventSink();
      const warningCalls = warnSpy.mock.calls.filter((c) => String(c[0]).includes('WARNING'));
      expect(warningCalls.length).toBe(1);
      warnSpy.mockRestore();
    });

    test('does NOT drop non-message-rendering tools (passes through)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = resolveToolEventSink();

      await sink.emitToolUseEvent('w1', { toolUseId: 't1', toolName: 'execute_bash', input: '{}' });
      expect(sendWebappEvent).toHaveBeenCalledTimes(1);

      await sink.emitToolUseEvent('w1', { toolUseId: 't2', toolName: 'read_file', input: '{}' });
      expect(sendWebappEvent).toHaveBeenCalledTimes(2);
    });

    test('drops the first sendMessageToUser emitToolUseEvent call', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = resolveToolEventSink();

      await sink.emitToolUseEvent('w1', {
        toolUseId: 't1',
        toolName: 'sendMessageToUser',
        input: '{"message":"hi"}',
      });

      expect(sendWebappEvent).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('DROPPED toolUse event | workerId=w1 toolName=sendMessageToUser toolUseId=t1')
      );
      warnSpy.mockRestore();
    });

    test('drops the first Send_Message_To_User (Bedrock sanitized name)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = resolveToolEventSink();

      await sink.emitToolUseEvent('w1', {
        toolUseId: 't1',
        toolName: 'Send_Message_To_User',
        input: '{}',
      });
      expect(sendWebappEvent).not.toHaveBeenCalled();
    });

    test('does NOT drop sendImageToUser / sendFileToUser (not in recovery scope)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = resolveToolEventSink();

      await sink.emitToolUseEvent('w1', { toolUseId: 't1', toolName: 'sendImageToUser', input: '{}' });
      expect(sendWebappEvent).toHaveBeenCalledTimes(1);

      await sink.emitToolUseEvent('w1', { toolUseId: 't2', toolName: 'sendFileToUser', input: '{}' });
      expect(sendWebappEvent).toHaveBeenCalledTimes(2);
    });

    test('skips non-message tools then drops the first message tool', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = resolveToolEventSink();

      // Generic tools pass through — one-shot is NOT consumed
      await sink.emitToolUseEvent('w1', { toolUseId: 't1', toolName: 'execute_bash', input: '{}' });
      await sink.emitToolUseEvent('w1', { toolUseId: 't2', toolName: 'think', input: '{}' });
      expect(sendWebappEvent).toHaveBeenCalledTimes(2);

      // First message-rendering tool gets dropped
      await sink.emitToolUseEvent('w1', { toolUseId: 't3', toolName: 'sendMessageToUser', input: '{}' });
      expect(sendWebappEvent).toHaveBeenCalledTimes(2); // no new call

      // Subsequent message-rendering tools pass through
      await sink.emitToolUseEvent('w1', { toolUseId: 't4', toolName: 'sendMessageToUser', input: '{}' });
      expect(sendWebappEvent).toHaveBeenCalledTimes(3);
    });

    test('emitToolResultEvent is never affected (always passes through)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = resolveToolEventSink();

      await sink.emitToolResultEvent('w1', { toolUseId: 't1', toolName: 'sendMessageToUser', output: 'data' });
      expect(sendWebappEvent).toHaveBeenCalledWith('w1', expect.objectContaining({ type: 'toolResult' }));
    });

    test('persistToolUseMessage is never affected', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = resolveToolEventSink();

      const result = await sink.persistToolUseMessage('w1', { role: 'assistant', content: [] });
      expect(result.SK).toBe('000000000000100');
    });

    test('persistToolResultMessage is never affected', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = resolveToolEventSink();

      const result = await sink.persistToolResultMessage('w1', { role: 'user', content: [] }, '000000000000100');
      expect(result.SK).toBe('000000000000101');
    });

    test('drop is one-shot across the worker process lifetime (module state)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink1 = resolveToolEventSink();
      const sink2 = resolveToolEventSink();

      // First message-tool call on sink1 drops
      await sink1.emitToolUseEvent('w1', { toolUseId: 't1', toolName: 'sendMessageToUser', input: '{}' });
      expect(sendWebappEvent).not.toHaveBeenCalled();

      // Second message-tool call on sink2 (same wrapped singleton) passes through
      await sink2.emitToolUseEvent('w1', { toolUseId: 't2', toolName: 'sendMessageToUser', input: '{}' });
      expect(sendWebappEvent).toHaveBeenCalledTimes(1);
    });
  });
});
