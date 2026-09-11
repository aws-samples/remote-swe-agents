import { z } from 'zod';

export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1536;
export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * A user-registered skill. The inference backend receives the user's skills so
 * a backend can detect skill activation for the current turn (see
 * `TurnContext.userSkills`). The full skill-management surface (storage limits,
 * S3 layout, zip handling, catalogue) is intentionally out of scope here — this
 * schema carries only the fields the inference seam depends on.
 */
export const skillSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  name: z.string().min(1).max(MAX_SKILL_NAME_LENGTH).regex(SKILL_NAME_PATTERN),
  description: z.string().max(MAX_SKILL_DESCRIPTION_LENGTH),
  allowedTools: z.array(z.string()).optional(),
  fileCount: z.number(),
  totalSize: z.number(),
  s3Prefix: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Skill = z.infer<typeof skillSchema>;
