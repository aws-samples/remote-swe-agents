import { describe, expect, test, vi, beforeEach } from 'vitest';
import { defaultToolEventSink } from './default-sink';

vi.mock('../messages', () => ({
  saveToolUseMessage: vi.fn(async (workerId: string, _msg: unknown, tokens: number, budget?: number) => ({
    PK: `message-${workerId}`,
    SK: '000000000000100',
    content: '[]',
    role: 'assistant',
    tokenCount: tokens,
    messageType: 'toolUse',
    thinkingBudget: budget,
  })),
  saveToolResultMessage: vi.fn(async (workerId: string, _msg: unknown, parentSK: string) => ({
    PK: `message-${workerId}`,
    SK: String(Number(parentSK) + 1).padStart(15, '0'),
    content: '[]',
    role: 'user',
    tokenCount: 0,
    messageType: 'toolResult',
  })),
}));

vi.mock('../events', () => ({
  sendWebappEvent: vi.fn(async () => undefined),
}));

const { saveToolUseMessage, saveToolResultMessage } = await import('../messages');
const { sendWebappEvent } = await import('../events');

describe('defaultToolEventSink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('persistToolUseMessage forwards args and returns SK + item', async () => {
    const msg = { role: 'assistant' as const, content: [] };
    const result = await defaultToolEventSink.persistToolUseMessage('w1', msg, {
      outputTokenCount: 42,
      thinkingBudget: 1024,
    });

    expect(saveToolUseMessage).toHaveBeenCalledWith('w1', msg, 42, 1024);
    expect(result.SK).toBe('000000000000100');
    expect(result.item.messageType).toBe('toolUse');
  });

  test('persistToolUseMessage defaults metadata', async () => {
    await defaultToolEventSink.persistToolUseMessage('w1', { role: 'assistant', content: [] });
    expect(saveToolUseMessage).toHaveBeenCalledWith('w1', expect.anything(), 0, undefined);
  });

  test('persistToolResultMessage chains on parent SK', async () => {
    const result = await defaultToolEventSink.persistToolResultMessage(
      'w1',
      { role: 'user', content: [] },
      '000000000000100'
    );
    expect(saveToolResultMessage).toHaveBeenCalledWith('w1', expect.anything(), '000000000000100');
    expect(result.SK).toBe('000000000000101');
    expect(result.item.messageType).toBe('toolResult');
  });

  test('emitToolUseEvent stringifies non-string input', async () => {
    await defaultToolEventSink.emitToolUseEvent('w1', {
      toolUseId: 't1',
      toolName: 'echo',
      input: { x: 1 },
    });
    expect(sendWebappEvent).toHaveBeenCalledWith('w1', {
      type: 'toolUse',
      toolName: 'echo',
      toolUseId: 't1',
      input: '{"x":1}',
      thinkingBudget: undefined,
      reasoningText: undefined,
    });
  });

  test('emitToolUseEvent preserves pre-serialized string input', async () => {
    await defaultToolEventSink.emitToolUseEvent('w1', {
      toolUseId: 't2',
      toolName: 'echo',
      input: '{"already":true}',
    });
    const call = vi.mocked(sendWebappEvent).mock.calls.at(-1)!;
    expect(call[1]).toMatchObject({ input: '{"already":true}' });
  });

  test('emitToolResultEvent passes output as-is', async () => {
    await defaultToolEventSink.emitToolResultEvent('w1', {
      toolUseId: 't1',
      toolName: 'echo',
      output: 'hello',
    });
    expect(sendWebappEvent).toHaveBeenCalledWith('w1', {
      type: 'toolResult',
      toolName: 'echo',
      toolUseId: 't1',
      output: 'hello',
    });
  });
});
