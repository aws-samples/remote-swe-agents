/**
 * RemoteSweBedrockModel stream-synthesis tests. Verifies the coarse
 * ConverseResponse → ModelStreamEvent translation (the piece that lets the
 * SDK's streamAggregated re-assemble a non-streaming bedrockConverse result).
 * The live bedrockConverse call is NOT exercised here (network).
 */
import { describe, it, expect } from 'vitest';
import type { Message as BedrockMessage } from '@aws-sdk/client-bedrock-runtime';
import { synthesizeStream, mapBedrockStopReason } from './remote-swe-bedrock-model';

function collect(msg: BedrockMessage, stopReason: string, usage?: Parameters<typeof synthesizeStream>[2]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [...synthesizeStream(msg, stopReason, usage)].map((e) => e as any);
}

describe('mapBedrockStopReason', () => {
  it('maps the common Bedrock stop reasons to the Strands union', () => {
    expect(mapBedrockStopReason('tool_use')).toBe('toolUse');
    expect(mapBedrockStopReason('end_turn')).toBe('endTurn');
    expect(mapBedrockStopReason('max_tokens')).toBe('maxTokens');
    expect(mapBedrockStopReason(undefined)).toBe('endTurn');
  });
});

describe('synthesizeStream', () => {
  it('emits start → text block → stop → metadata for a text message', () => {
    const events = collect({ role: 'assistant', content: [{ text: 'hello' }] }, 'end_turn', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
    });
    expect(events[0].type).toBe('modelMessageStartEvent');
    expect(events[1].type).toBe('modelContentBlockStartEvent');
    expect(events[2]).toMatchObject({
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'textDelta', text: 'hello' },
    });
    expect(events[3].type).toBe('modelContentBlockStopEvent');
    const stop = events.find((e) => e.type === 'modelMessageStopEvent');
    expect(stop.stopReason).toBe('endTurn');
    const meta = events.find((e) => e.type === 'modelMetadataEvent');
    expect(meta.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 3 });
  });

  it('emits a toolUseStart + toolUseInputDelta for a toolUse block', () => {
    const events = collect(
      { role: 'assistant', content: [{ toolUse: { toolUseId: 'c1', name: 'fs_read', input: { path: '/a' } } }] },
      'tool_use'
    );
    const start = events.find((e) => e.type === 'modelContentBlockStartEvent');
    expect(start.start).toMatchObject({ type: 'toolUseStart', name: 'fs_read', toolUseId: 'c1' });
    const delta = events.find((e) => e.type === 'modelContentBlockDeltaEvent');
    expect(delta.delta).toMatchObject({ type: 'toolUseInputDelta', input: JSON.stringify({ path: '/a' }) });
    const stop = events.find((e) => e.type === 'modelMessageStopEvent');
    expect(stop.stopReason).toBe('toolUse');
  });

  it('emits a reasoningContentDelta for a reasoningContent block', () => {
    const events = collect(
      { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'thinking', signature: 'sig' } } }] },
      'end_turn'
    );
    const delta = events.find((e) => e.type === 'modelContentBlockDeltaEvent');
    expect(delta.delta).toMatchObject({ type: 'reasoningContentDelta', text: 'thinking', signature: 'sig' });
  });

  it('omits the metadata event when usage is absent', () => {
    const events = collect({ role: 'assistant', content: [{ text: 'x' }] }, 'end_turn');
    expect(events.find((e) => e.type === 'modelMetadataEvent')).toBeUndefined();
  });

  it('handles a multi-block (text + toolUse) message in order', () => {
    const events = collect(
      { role: 'assistant', content: [{ text: 'let me check' }, { toolUse: { toolUseId: 'c', name: 't', input: {} } }] },
      'tool_use'
    );
    const starts = events.filter((e) => e.type === 'modelContentBlockStartEvent');
    expect(starts.length).toBe(2);
    expect(starts[1].start).toMatchObject({ type: 'toolUseStart', name: 't' });
  });
});

import { vi } from 'vitest';
import { RemoteSweBedrockModel } from './remote-swe-bedrock-model';
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';

vi.mock('@remote-swe-agents/agent-core/lib', async () => {
  const actual = await vi.importActual<typeof import('@remote-swe-agents/agent-core/lib')>(
    '@remote-swe-agents/agent-core/lib'
  );
  return {
    ...actual,
    bedrockConverse: vi.fn().mockResolvedValue({
      response: {
        output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      thinkingBudget: undefined,
    }),
  };
});

describe('RemoteSweBedrockModel stream() per-call middle-out', () => {
  it('applies middleOutFiltering when item token sum exceeds threshold', async () => {
    const { bedrockConverse } = await import('@remote-swe-agents/agent-core/lib');
    const mockConverse = vi.mocked(bedrockConverse);

    // Create items with high token counts that exceed threshold
    const items: MessageItem[] = [
      {
        PK: 'message-w1',
        SK: '001',
        role: 'user',
        content: JSON.stringify([{ text: 'msg1' }]),
        tokenCount: 5000,
        messageType: 'user',
      },
      {
        PK: 'message-w1',
        SK: '002',
        role: 'assistant',
        content: JSON.stringify([{ text: 'resp1' }]),
        tokenCount: 5000,
        messageType: 'assistant',
      },
      {
        PK: 'message-w1',
        SK: '003',
        role: 'user',
        content: JSON.stringify([{ text: 'msg2' }]),
        tokenCount: 5000,
        messageType: 'user',
      },
      {
        PK: 'message-w1',
        SK: '004',
        role: 'assistant',
        content: JSON.stringify([{ text: 'resp2' }]),
        tokenCount: 5000,
        messageType: 'assistant',
      },
      {
        PK: 'message-w1',
        SK: '005',
        role: 'user',
        content: JSON.stringify([{ text: 'msg3' }]),
        tokenCount: 5000,
        messageType: 'user',
      },
    ];
    // Total = 25000, threshold = 10000 → middle-out should fire

    const model = new RemoteSweBedrockModel({
      workerId: 'w1',
      modelTypes: ['sonnet4' as any],
      getItems: () => items,
      tokenThreshold: 10000,
    });

    // Consume the async iterator to trigger stream()
    const events: any[] = [];
    // Pass dummy Strands messages (won't be used when getItems is configured)
    for await (const e of model.stream([], {})) {
      events.push(e);
    }

    // bedrockConverse should have been called with FEWER messages than items.length
    // (middleOutFiltering removes middle items to fit threshold)
    expect(mockConverse).toHaveBeenCalledTimes(1);
    const callArgs = mockConverse.mock.calls[0]!;
    const converseInput = callArgs[2] as { messages: any[] };
    expect(converseInput.messages.length).toBeLessThan(items.length);
  });
});

describe('RemoteSweBedrockModel stream() under threshold', () => {
  it('passes all messages through when token sum is below threshold', async () => {
    const { bedrockConverse } = await import('@remote-swe-agents/agent-core/lib');
    const mockConverse = vi.mocked(bedrockConverse);
    mockConverse.mockClear();

    const items: MessageItem[] = [
      {
        PK: 'message-w1',
        SK: '001',
        role: 'user',
        content: JSON.stringify([{ text: 'msg1' }]),
        tokenCount: 100,
        messageType: 'user',
      },
      {
        PK: 'message-w1',
        SK: '002',
        role: 'assistant',
        content: JSON.stringify([{ text: 'resp1' }]),
        tokenCount: 100,
        messageType: 'assistant',
      },
      {
        PK: 'message-w1',
        SK: '003',
        role: 'user',
        content: JSON.stringify([{ text: 'msg2' }]),
        tokenCount: 100,
        messageType: 'user',
      },
    ];
    // Total = 300, threshold = 10000 → no filtering

    const model = new RemoteSweBedrockModel({
      workerId: 'w1',
      modelTypes: ['sonnet4' as any],
      getItems: () => items,
      tokenThreshold: 10000,
    });

    for await (const _ of model.stream([], {})) {
      /* consume */
    }

    expect(mockConverse).toHaveBeenCalledTimes(1);
    const callArgs = mockConverse.mock.calls[0]!;
    const converseInput = callArgs[2] as { messages: any[] };
    // All items should pass through (noOpFiltering preserves all)
    expect(converseInput.messages.length).toBe(items.length);
  });
});
