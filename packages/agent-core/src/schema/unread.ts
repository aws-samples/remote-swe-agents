import { z } from 'zod';

export const unreadItemSchema = z.object({
  PK: z.string(), // unread-{userId}
  SK: z.string(), // {workerId}
  unreadCount: z.number(),
  hasPending: z.boolean().default(false),
  lastReadAt: z.number().default(0),
  updatedAt: z.number(),
});

export type UnreadItem = z.infer<typeof unreadItemSchema>;
