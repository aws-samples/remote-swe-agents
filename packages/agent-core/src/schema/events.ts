import z from 'zod';
import { agentStatusSchema } from './agent';
import { instanceStatusSchema } from './session';

export const webappEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    role: z.union([z.literal('user'), z.literal('assistant')]),
    workerId: z.string(),
    message: z.string(),
    timestamp: z.number(),
    messageSK: z.string().optional(),
    thinkingBudget: z.number().optional(),
    reasoningText: z.string().optional(),
    /**
     * For user messages: identifies the human who sent the message so other
     * viewers of the same session (webapp/Slack) can render the sender name.
     * All fields are optional to preserve backward compatibility with events
     * emitted before this schema addition.
     */
    senderUserId: z.string().optional(),
    senderDisplayName: z.string().optional(),
    senderType: z.union([z.literal('slack'), z.literal('webapp'), z.literal('apikey')]).optional(),
    /**
     * Submission-specific identifier generated client-side (`crypto.randomUUID()`)
     * when the user types a message in the webapp. The server action receives
     * the id as part of the action input and forwards it verbatim on the
     * rebroadcast event so the originating tab can recognize the echo and
     * collapse it into its existing optimistic bubble (see `dedup.ts`).
     *
     * Transient: NEVER persisted to DynamoDB. Only meaningful on the
     * realtime event payload. Other producers (Slack, REST API key) leave
     * this field undefined; their messages are never echoed back to a
     * pending bubble, so they never need a clientId.
     */
    clientId: z.string().optional(),
    imageKeys: z.array(z.string()).optional(),
    fileKeys: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('toolUse'),
    toolName: z.string(),
    workerId: z.string(),
    toolUseId: z.string(),
    input: z.string(),
    timestamp: z.number(),
    messageSK: z.string().optional(),
    thinkingBudget: z.number().optional(),
    reasoningText: z.string().optional(),
  }),
  z.object({
    type: z.literal('toolResult'),
    toolName: z.string(),
    workerId: z.string(),
    toolUseId: z.string(),
    output: z.string(),
    imageKeys: z.array(z.string()).optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('instanceStatusChanged'),
    status: instanceStatusSchema,
    workerId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('agentStatusUpdate'),
    status: agentStatusSchema,
    timestamp: z.number(),
    workerId: z.string(),
  }),
  z.object({
    type: z.literal('sessionTitleUpdate'),
    newTitle: z.string(),
    timestamp: z.number(),
    workerId: z.string(),
  }),
  z.object({
    type: z.literal('lastMessageUpdate'),
    lastMessage: z.string(),
    lastMessageAt: z.number().optional(),
    timestamp: z.number(),
    workerId: z.string(),
  }),
  z.object({
    type: z.literal('eventTriggerFired'),
    message: z.string(),
    name: z.string().optional(),
    id: z.string().optional(),
    timestamp: z.number(),
    workerId: z.string(),
  }),
  z.object({
    type: z.literal('agentError'),
    errorType: z.string(),
    errorMessage: z.string(),
    consecutiveCount: z.number(),
    willRetry: z.boolean(),
    timestamp: z.number(),
    workerId: z.string(),
  }),
  z.object({
    type: z.literal('unreadUpdate'),
    workerId: z.string(),
    userId: z.string(),
    unreadCount: z.number(),
    hasPending: z.boolean(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('agentMessage'),
    senderSessionId: z.string(),
    senderName: z.string(),
    targetSessionId: z.string(),
    targetName: z.string(),
    message: z.string(),
    acknowledge: z.boolean(),
    timestamp: z.number(),
    workerId: z.string(),
  }),
  z.object({
    type: z.literal('sessionDeleted'),
    workerId: z.string(),
    success: z.boolean(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('portsUpdate'),
    workerId: z.string(),
    hostname: z.string().optional(),
    openedPorts: z.array(
      z.object({
        fromPort: z.number(),
        toPort: z.number(),
        cidr: z.string(),
        openedAt: z.number(),
      })
    ),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('sessionReparented'),
    workerId: z.string(),
    newParentSessionId: z.string(),
    oldParentSessionId: z.string().nullable(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('childSleeping'),
    childSessionId: z.string(),
    hasPendingTriggers: z.boolean(),
    workerId: z.string(),
    timestamp: z.number(),
  }),
]);
