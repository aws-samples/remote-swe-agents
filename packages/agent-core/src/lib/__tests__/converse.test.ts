import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';

// Import and mock the module to isolate the detectThinkingBudget function for testing
jest.mock('@aws-sdk/client-bedrock-runtime');
jest.mock('@aws-sdk/client-sts');
jest.mock('../aws', () => ({
  ddb: {
    send: jest.fn(),
  },
  TableName: undefined,
}));

// Import the actual module under test
const originalModule = jest.requireActual('../converse');

// Create a test suite for the detectThinkingBudget function
describe('detectThinkingBudget', () => {
  // We need to access the private function for testing
  const detectThinkingBudget: (input: ConverseCommandInput) => number = (originalModule as any).detectThinkingBudget;
  const DEFAULT_THINKING_BUDGET = 1024;
  const EXTENDED_THINKING_BUDGET = 4096;

  // Test case: should return default budget when there are no messages
  test('should return default budget when there are no messages', () => {
    const input: Partial<ConverseCommandInput> = {
      messages: [],
    };
    
    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result).toBe(DEFAULT_THINKING_BUDGET);
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
    expect(result).toBe(DEFAULT_THINKING_BUDGET);
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
    expect(result).toBe(EXTENDED_THINKING_BUDGET);
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
    expect(result).toBe(DEFAULT_THINKING_BUDGET);
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
    expect(result).toBe(EXTENDED_THINKING_BUDGET);
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
    expect(result).toBe(DEFAULT_THINKING_BUDGET);
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
    expect(result).toBe(EXTENDED_THINKING_BUDGET);
  });

  // Test case: should handle non-text content parts
  test('should handle non-text content parts', () => {
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
              image: Buffer.from('dummy image data'),
            },
          ],
        },
      ],
    };
    
    const result = detectThinkingBudget(input as ConverseCommandInput);
    expect(result).toBe(EXTENDED_THINKING_BUDGET);
  });
});