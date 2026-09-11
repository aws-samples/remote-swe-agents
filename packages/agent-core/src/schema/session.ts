import { z } from 'zod';
import { agentStatusSchema, runtimeTypeSchema } from './agent';
import { inferenceModeSchema, kiroModelSchema, modelTypeSchema } from './model';

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
  updatedAt: z.number(),
  LSI1: z.string(),
  initialMessage: z.string(),
  instanceStatus: instanceStatusSchema,
  sessionCost: z.number(),
  agentStatus: agentStatusSchema,
  initiator: z.string().optional(),
  isHidden: z.boolean().optional(),
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  title: z.string().optional(),
  lastMessage: z.string().optional(),
  lastMessageAt: z.number().optional(),
  customAgentId: z.string().optional(),
  runtimeType: runtimeTypeSchema.optional(),
  parentSessionId: z.string().optional(),
  creatorSessionId: z.string().optional(),
  // Worker ID of the successor session this session was handed over to (webapp
  // handover feature). Written exactly once with a conditional update — its
  // presence is the idempotency guard that prevents concurrent/repeated
  // handovers from creating multiple successors.
  handedOverTo: z.string().optional(),
  agentName: z.string().optional(),
  inferenceMode: inferenceModeSchema.optional(),
  kiroModel: z.string().optional(),
  bedrockDefaultModel: modelTypeSchema.optional(),
  kiroDefaultModel: kiroModelSchema.optional(),
  kiroSessionId: z.string().optional(),
  // Most recent normalised context-window utilisation (%) measured at the end
  // of a turn. Persisted so the NEXT turn can show the model its own context
  // usage via a dynamic environment block so the agent can decide, on its own,
  // to hand over to a successor. Not shown when absent (e.g. a first turn).
  lastContextUsagePercentage: z.number().optional(),
  rewindState: z
    .object({
      cutoffSK: z.string(),
      rewindedAt: z.number(),
    })
    .optional(),
  // The source session ID whose conversation history should be dumped to a
  // local file on worker startup. Set during successor (handover) session
  // creation so the new worker can provide full prior-session context.
  handoverSourceSessionId: z.string().optional(),
});

export type SessionItem = z.infer<typeof sessionItemSchema>;
