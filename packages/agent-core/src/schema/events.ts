import z from 'zod';
import { agentStatusSchema } from './agent';

export const webappEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    role: z.union([z.literal('user'), z.literal('assistant')]),
    workerId: z.string(),
    message: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('toolUse'),
    toolName: z.string(),
    workerId: z.string(),
    toolUseId: z.string(),
    input: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('toolResult'),
    toolName: z.string(),
    workerId: z.string(),
    toolUseId: z.string(),
    output: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('instanceStatusChanged'),
    status: z.union([z.literal('starting'), z.literal('running'), z.literal('stopped')]),
    workerId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('agentStatusUpdate'),
    status: agentStatusSchema,
    timestamp: z.number(),
    workerId: z.string(),
  }),
]);
