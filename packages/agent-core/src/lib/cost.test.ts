import { expect, test } from 'vitest';
import { calculateCost } from './cost';

test('calculateCost for sonnet3.7 model', () => {
  // GIVEN
  const modelId = 'us.anthropic.claude-3-7-sonnet-20250219-v1:0';
  const inputTokens = 1000;
  const outputTokens = 500;
  const cacheReadTokens = 200;
  const cacheWriteTokens = 100;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN
  const expectedCost = (1000 * 0.003 + 500 * 0.015 + 200 * 0.0003 + 100 * 0.00375) / 1000;
  expect(cost).toBe(expectedCost);
});

test('calculateCost for haiku3.5 model', () => {
  // GIVEN
  const modelId = 'apac.anthropic.claude-3-5-haiku-20241022-v1:0';
  const inputTokens = 2000;
  const outputTokens = 1000;
  const cacheReadTokens = 500;
  const cacheWriteTokens = 250;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN
  const expectedCost = (2000 * 0.0008 + 1000 * 0.004 + 500 * 0.00008 + 250 * 0.001) / 1000;
  expect(cost).toBe(expectedCost);
});

test('calculateCost returns 0 for unknown model', () => {
  // GIVEN
  const modelId = 'unknown-model-id';
  const inputTokens = 1000;
  const outputTokens = 500;
  const cacheReadTokens = 200;
  const cacheWriteTokens = 100;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN
  expect(cost).toBe(0);
});

test('calculateCost with zero tokens', () => {
  // GIVEN
  const modelId = 'anthropic.claude-sonnet-4-20250514-v1:0';
  const inputTokens = 0;
  const outputTokens = 0;
  const cacheReadTokens = 0;
  const cacheWriteTokens = 0;

  // WHEN
  const cost = calculateCost(modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  // THEN
  expect(cost).toBe(0);
});
