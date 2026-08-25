import { describe, it, expect } from 'vitest';
import { computeMessageTokenCount } from './token-attribution';

describe('computeMessageTokenCount', () => {
  it('computes positive token count when input exceeds prior total', () => {
    const usage = { inputTokens: 5000, cacheReadInputTokens: 1000, cacheWriteInputTokens: 500 };
    const result = computeMessageTokenCount(usage, 4000);
    // 5000 + 1000 + 500 - 4000 = 2500
    expect(result).toBe(2500);
  });

  it('allows negative values (reasoning drop adjusts total per legacy design)', () => {
    const usage = { inputTokens: 3000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
    // totalSoFar is larger than input because reasoningContent was dropped
    const result = computeMessageTokenCount(usage, 5000);
    // 3000 - 5000 = -2000
    expect(result).toBe(-2000);
  });

  it('returns zero when input exactly equals prior total', () => {
    const usage = { inputTokens: 1000, cacheReadInputTokens: 500, cacheWriteInputTokens: 500 };
    const result = computeMessageTokenCount(usage, 2000);
    expect(result).toBe(0);
  });

  it('includes all cache token fields in total input computation', () => {
    const usage = { inputTokens: 100, cacheReadInputTokens: 200, cacheWriteInputTokens: 300 };
    const result = computeMessageTokenCount(usage, 0);
    // All three fields should be summed: 100 + 200 + 300 = 600
    expect(result).toBe(600);
  });
});

describe('computeMessageTokenCount multi-call scenario (lastUserMessageSK switching)', () => {
  it('second call attribution uses updated totalSoFar (simulates toolResult SK switch)', () => {
    // First call: user message attribution
    const usage1 = { inputTokens: 5000, cacheReadInputTokens: 500, cacheWriteInputTokens: 200 };
    const totalSoFar1 = 3000; // seed items total
    const tokenCount1 = computeMessageTokenCount(usage1, totalSoFar1);
    // 5000 + 500 + 200 - 3000 = 2700
    expect(tokenCount1).toBe(2700);

    // After first call: totalSoFar grows by tokenCount1 + outputTokens
    const outputTokens1 = 800;
    const totalSoFar2 = totalSoFar1 + tokenCount1 + outputTokens1;
    // 3000 + 2700 + 800 = 6500

    // Second call: toolResult attribution (lastUserMessageSK has switched)
    const usage2 = { inputTokens: 7000, cacheReadInputTokens: 1000, cacheWriteInputTokens: 300 };
    const tokenCount2 = computeMessageTokenCount(usage2, totalSoFar2);
    // 7000 + 1000 + 300 - 6500 = 1800
    expect(tokenCount2).toBe(1800);
  });
});
