import { describe, expect, test } from 'vitest';
import { deepMerge, preProcessInput } from './converse';
import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';

const baseInput = (userText = 'hello'): ConverseCommandInput => ({
  modelId: 'dummy',
  messages: [{ role: 'user', content: [{ text: userText }] }],
});

describe('deepMerge', () => {
  test('merges flat objects', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test('later values override earlier ones', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test('concatenates arrays', () => {
    expect(deepMerge({ arr: ['a'] }, { arr: ['b'] })).toEqual({ arr: ['a', 'b'] });
  });

  test('deep merges nested objects', () => {
    expect(deepMerge({ nested: { a: 1, b: 2 } }, { nested: { b: 3, c: 4 } })).toEqual({ nested: { a: 1, b: 3, c: 4 } });
  });

  test('merges three objects with array concatenation', () => {
    expect(deepMerge({ arr: ['a'] }, { arr: ['b'] }, { arr: ['c'] })).toEqual({ arr: ['a', 'b', 'c'] });
  });

  test('returns empty object for no inputs', () => {
    expect(deepMerge()).toEqual({});
  });
});

describe('preProcessInput', () => {
  describe('reasoning model with interleaved thinking (sonnet4.6)', () => {
    test('sets reasoning_config and interleaved-thinking beta header', () => {
      const { input } = preProcessInput(baseInput(), 'sonnet4.6', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toEqual({
        type: 'enabled',
        budget_tokens: 2000,
      });
      expect(fields.anthropic_beta).toEqual(['interleaved-thinking-2025-05-14']);
    });
  });

  describe('long context model with reasoning (sonnet4.6-long-context-mode)', () => {
    test('merges reasoning, interleaved-thinking and long context beta headers', () => {
      const { input } = preProcessInput(baseInput(), 'sonnet4.6-long-context-mode', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toEqual({
        type: 'enabled',
        budget_tokens: 2000,
      });
      expect(fields.anthropic_beta).toEqual(
        expect.arrayContaining(['interleaved-thinking-2025-05-14', 'context-1m-2025-08-07'])
      );
      expect((fields.anthropic_beta as string[]).length).toBe(2);
    });
  });

  describe('non-reasoning model (sonnet3.5)', () => {
    test('does not set reasoning_config or beta headers', () => {
      const { input } = preProcessInput(baseInput(), 'sonnet3.5', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown> | undefined;
      expect(fields?.reasoning_config).toBeUndefined();
      expect(fields?.anthropic_beta).toBeUndefined();
    });
  });

  describe('non-reasoning model strips reasoningContent', () => {
    test('removes reasoningContent from messages', () => {
      const input: ConverseCommandInput = {
        modelId: 'dummy',
        messages: [
          { role: 'user', content: [{ text: 'hello' }] },
          {
            role: 'assistant',
            content: [{ reasoningContent: { reasoningText: { text: 'thinking...' } } } as any, { text: 'response' }],
          },
          { role: 'user', content: [{ text: 'follow up' }] },
        ],
      };
      const { input: processed } = preProcessInput(input, 'sonnet3.5', 0);
      const assistantContent = processed.messages![1].content!;
      expect(assistantContent).toHaveLength(1);
      expect(assistantContent[0]).toEqual({ text: 'response' });
    });
  });

  describe('reasoning model without interleaved thinking (sonnet3.7)', () => {
    test('sets reasoning_config but no interleaved-thinking header', () => {
      const { input } = preProcessInput(baseInput(), 'sonnet3.7', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toEqual({
        type: 'enabled',
        budget_tokens: 2000,
      });
      expect(fields.anthropic_beta).toBeUndefined();
    });
  });

  describe('long context model without reasoning enabled', () => {
    test('only sets long context beta header when reasoning is disabled by toolChoice', () => {
      const input: ConverseCommandInput = {
        modelId: 'dummy',
        messages: [{ role: 'user', content: [{ text: 'hello' }] }],
        toolConfig: {
          toolChoice: { any: {} },
          tools: [{ toolSpec: { name: 'test', inputSchema: { json: {} } } }],
        },
      };
      const { input: processed } = preProcessInput(input, 'sonnet4.6-long-context-mode', 0);
      const fields = processed.additionalModelRequestFields as Record<string, unknown>;
      expect(fields.reasoning_config).toBeUndefined();
      expect(fields.anthropic_beta).toEqual(['context-1m-2025-08-07']);
    });
  });

  describe('ultrathink keyword', () => {
    test('increases thinking budget when ultrathink is in user message', () => {
      const { input, thinkingBudget } = preProcessInput(baseInput('please ultrathink this'), 'sonnet4.6', 0);
      const fields = input.additionalModelRequestFields as Record<string, unknown>;
      const config = fields.reasoning_config as { budget_tokens: number };
      expect(config.budget_tokens).toBeGreaterThan(2000);
      expect(thinkingBudget).toBe(config.budget_tokens);
    });

    test('does not increase budget without ultrathink keyword', () => {
      const { thinkingBudget } = preProcessInput(baseInput('just a normal message'), 'sonnet4.6', 0);
      expect(thinkingBudget).toBeUndefined();
    });
  });
});
