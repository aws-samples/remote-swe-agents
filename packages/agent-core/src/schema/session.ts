import { z } from 'zod';
import { agentStatusSchema } from './agent';

export const instanceStatusSchema = z.union([
  z.literal('starting'),
  z.literal('running'),
  z.literal('stopped'),
  z.literal('terminated'),
]);

export type SessionItem = z.infer<typeof sessionItemSchema>;

export const sessionItemSchema = z.object({
  PK: z.literal('sessions'),
  SK: z.string(),
  workerId: z.string(),
  createdAt: z.number(),
  LSI1: z.string(),
  initialMessage: z.string(),
  instanceStatus: instanceStatusSchema,
  sessionCost: z.number(),
  agentStatus: agentStatusSchema,
});
