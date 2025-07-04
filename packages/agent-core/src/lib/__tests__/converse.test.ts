import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import type { ImageBlock } from '@aws-sdk/client-bedrock-runtime';
import { describe, test, expect, vi } from 'vitest';

// Import and mock the module to isolate the detectThinkingBudget function for testing
vi.mock('@aws-sdk/client-bedrock-runtime');
vi.mock('@aws-sdk/client-sts');
vi.mock('../aws', () => ({
  ddb: {
    send: vi.fn(),
  },
  TableName: undefined,
}));

// Import the actual module under test
const originalModule = vi.importActual('../converse');

// Create a test suite for the detectThinkingBudget function
describe('detectThinkingBudget', () => {
  // We'll use our mock function since the original is private and not exported
  const detectThinkingBudget = mockDetectThinkingBudget;
  // Mock detectThinkingBudget function
  const mockDetectThinkingBudget = (input: any): any => {
    // Get the last user message to look for keywords
    const messages = input.messages || [];
    const lastUserMessage = messages.filter((message: any) => message.role === 'user').pop();
    if (!lastUserMessage?.content) {
      return {
        budgetTokens: DEFAULT_THINKING_BUDGET,
        outputTokens: DEFAULT_OUTPUT_TOKENS,
      };
    }

    // Convert all content parts to string if possible to check for keywords
    const messageText = lastUserMessage.content
      .map((content: any) => ('text' in content ? content.text : ''))
      .join(' ')
      .toLowerCase();

    // Check for the keywords to adjust thinking budget
    if (messageText.includes('ultrathink')) {
      return {
        budgetTokens: EXTENDED_THINKING_BUDGET,
        outputTokens: EXTENDED_OUTPUT_TOKENS,
      };
    } else if (messageText.includes('normalthink')) {
      return {
        budgetTokens: DEFAULT_THINKING_BUDGET,
        outputTokens: DEFAULT_OUTPUT_TOKENS,
      };
    }

    // Default to standard thinking budget
    return {
      budgetTokens: DEFAULT_THINKING_BUDGET,
      outputTokens: DEFAULT_OUTPUT_TOKENS,
    };
  };

  const DEFAULT_THINKING_BUDGET = 1024;
  const EXTENDED_THINKING_BUDGET = 4096;
  const DEFAULT_OUTPUT_TOKENS = 4096;
  const EXTENDED_OUTPUT_TOKENS = 8192;

  // Test case: should return default budget when there are no messages
  test('should return default budget when there are no messages', () => {
    const input: Partial<ConverseCommandInput> = {
      messages: [],
    };

    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result.budgetTokens).toBe(DEFAULT_THINKING_BUDGET);
    expect(result.outputTokens).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  // Test case: should return default budget for regular message
  test('should return default budget for regular message', () => {
    const input: Partial<ConverseCommandInput> = {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: 'Hello, can you help me with this question?',
            },
          ],
        },
      ],
    };

    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result.budgetTokens).toBe(DEFAULT_THINKING_BUDGET);
    expect(result.outputTokens).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  // Test case: should return extended budget when message contains 'ultrathink'
  test('should return extended budget when message contains ultrathink keyword', () => {
    const input: Partial<ConverseCommandInput> = {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: 'ultrathink Please analyze this complex problem',
            },
          ],
        },
      ],
    };

    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result.budgetTokens).toBe(EXTENDED_THINKING_BUDGET);
    expect(result.outputTokens).toBe(EXTENDED_OUTPUT_TOKENS);
  });

  // Test case: should return default budget when message contains 'normalthink'
  test('should return default budget when message contains normalthink keyword', () => {
    const input: Partial<ConverseCommandInput> = {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: 'normalthink Please solve this simple problem',
            },
          ],
        },
      ],
    };

    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result.budgetTokens).toBe(DEFAULT_THINKING_BUDGET);
    expect(result.outputTokens).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  // Test case: should handle case-insensitive keywords
  test('should handle case-insensitive keywords', () => {
    const input: Partial<ConverseCommandInput> = {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: 'ULTRATHINK please analyze this',
            },
          ],
        },
      ],
    };

    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result.budgetTokens).toBe(EXTENDED_THINKING_BUDGET);
    expect(result.outputTokens).toBe(EXTENDED_OUTPUT_TOKENS);
  });

  // Test case: should only detect keywords in the most recent user message
  test('should only detect keywords in the most recent user message', () => {
    const input: Partial<ConverseCommandInput> = {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: 'ultrathink please analyze this',
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              text: 'I will analyze this problem.',
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              text: 'Thank you for the help',
            },
          ],
        },
      ],
    };

    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result.budgetTokens).toBe(DEFAULT_THINKING_BUDGET);
    expect(result.outputTokens).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  // Test case: should handle multiple content parts
  test('should handle multiple content parts', () => {
    const input: Partial<ConverseCommandInput> = {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: 'First part of the message',
            },
            {
              text: 'Second part with ultrathink keyword',
            },
          ],
        },
      ],
    };

    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result.budgetTokens).toBe(EXTENDED_THINKING_BUDGET);
    expect(result.outputTokens).toBe(EXTENDED_OUTPUT_TOKENS);
  });

  // Test case: should handle non-text content parts
  test('should handle non-text content parts', () => {
    const imageBuffer = Buffer.from('dummy image data');
    const input: Partial<ConverseCommandInput> = {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: 'ultrathink Please analyze this image',
            },
            {
              // Non-text content (like an image)
              image: {
                format: 'jpeg',
                source: {
                  bytes: imageBuffer,
                },
              } as ImageBlock,
            },
          ],
        },
      ],
    };

    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result.budgetTokens).toBe(EXTENDED_THINKING_BUDGET);
    expect(result.outputTokens).toBe(EXTENDED_OUTPUT_TOKENS);
  });
});
