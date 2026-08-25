/**
 * Pure function: compute the token count to attribute to a user message.
 *
 * tokenCount = totalInputTokensForThisCall - totalTokenCountSoFar
 * Negative values are intentional (legacy L437: reasoningContent drop adjusts total).
 */
export function computeMessageTokenCount(
  usage: { inputTokens: number; cacheReadInputTokens: number; cacheWriteInputTokens: number },
  totalTokenCountSoFar: number
): number {
  const totalInputForCall = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheWriteInputTokens;
  return totalInputForCall - totalTokenCountSoFar;
}
