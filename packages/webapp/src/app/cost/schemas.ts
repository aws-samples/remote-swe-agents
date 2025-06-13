import { z } from 'zod';

// Schema for cost data fetching
export const fetchCostDataSchema = z.object({
  // Optional start date for filtering (timestamp)
  startDate: z.number().optional(),
  // Optional end date for filtering (timestamp)
  endDate: z.number().optional(),
});

// Schema for model cost breakdown
export const modelCostSchema = z.object({
  modelId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  totalCost: z.number(),
});

// Schema for session cost data
export const sessionCostSchema = z.object({
  workerId: z.string(),
  initialMessage: z.string().optional(),
  sessionCost: z.number(),
  createdAt: z.number(),
});
