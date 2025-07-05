import { z } from 'zod';
import { agentStatusSchema } from './agent';

export const instanceStatusSchema = z.union([
  z.literal('starting'),
  z.literal('running'),
  z.literal('stopped'),
  z.literal('terminated'),
]);

export type InstanceStatus = z.infer<typeof instanceStatusSchema>;

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
  initiator: z.string().optional(),
  isHidden: z.boolean().optional(),
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
});

export type SessionItem = z.infer<typeof sessionItemSchema>;
