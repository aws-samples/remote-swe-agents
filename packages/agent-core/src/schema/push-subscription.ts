import { z } from 'zod';

export const pushSubscriptionSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  endpoint: z.string(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
  createdAt: z.number(),
});

export type PushSubscriptionItem = z.infer<typeof pushSubscriptionSchema>;
