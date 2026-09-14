import {
  agentStatusSchema,
  kiroModelSchema,
  modelTypeSchema,
  runtimeTypeSchema,
} from '@remote-swe-agents/agent-core/schema';
import { z } from 'zod';

export const sendMessageToAgentSchema = z.object({
  workerId: z.string(),
  message: z.string().min(1),
  imageKeys: z.array(z.string()).optional(),
  fileKeys: z.array(z.string()).optional(),
  modelOverride: modelTypeSchema.optional(),
  /**
   * Per-message Kiro model override. Only honoured on Kiro sessions.
   * Ignored on Bedrock sessions.
   *
   * The string is interpolated into a `/model <id>` slash command prompt
   * that kiro-cli parses as a command. Restricting it to model-id-safe
   * characters is a defence-in-depth guard against a malicious or
   * DevTools-tampered request injecting additional slash commands via
   * newline / whitespace / control characters. Authorised catalog model
   * ids match [a-zA-Z0-9._-]+ (see kiroModelConfigs).
   */
  kiroModelOverride: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+$/, 'invalid kiro model id')
    .max(64)
    .optional(),
  /**
   * Client-side submission UUID (`crypto.randomUUID()` in `MessageForm`).
   * Forwarded verbatim onto the realtime rebroadcast event so the originating
   * tab can recognize its own echo and skip it (see `dedup.ts`). Optional so
   * non-webapp callers and older clients still pass schema validation.
   *
   * Restricted to a UUID-shaped string (length-bounded, character-bounded)
   * to keep the comparison key cheap and prevent a client from sending an
   * arbitrarily large header that would be echoed back through the
   * websocket payload.
   */
  clientId: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/, 'invalid client id')
    .max(64)
    .optional(),
});

export const fetchTodoListSchema = z.object({
  workerId: z.string(),
});

export const updateAgentStatusSchema = z.object({
  workerId: z.string(),
  status: agentStatusSchema,
});

export const sendEventSchema = z.object({
  workerId: z.string(),
  event: z.object({
    type: z.literal('forceStop'),
  }),
});

export const stopSessionSchema = z.object({
  workerId: z.string(),
});

export const handoverSessionSchema = z.object({
  workerId: z.string(),
});

export const markSessionReadSchema = z.object({
  workerId: z.string(),
});

export const rewindSessionSchema = z.object({
  workerId: z.string(),
  cutoffSK: z.string().min(1),
});

export const undoRewindSchema = z.object({
  workerId: z.string(),
});

export const searchSessionContentSchema = z.object({
  workerId: z.string(),
  query: z.string().min(1).max(200),
});

export const updateSessionModelSchema = z.object({
  workerId: z.string(),
  bedrockDefaultModel: modelTypeSchema.optional(),
  kiroDefaultModel: kiroModelSchema.optional(),
});
