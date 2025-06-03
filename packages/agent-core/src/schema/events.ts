import z from 'zod';

export const webappEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    role: z.union([z.literal('user'), z.literal('assistant')]),
    message: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('toolUse'),
    toolName: z.string(),
    input: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('toolResult'),
    toolName: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('instanceStatusChanged'),
    status: z.union([z.literal('starting'), z.literal('running'), z.literal('sleeping')]),
    timestamp: z.number(),
  }),
]);
