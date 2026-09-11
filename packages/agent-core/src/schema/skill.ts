import { z } from 'zod';

export const MAX_SKILL_FILE_COUNT = 500;
export const MAX_SKILLS_PER_USER = 100;
export const MAX_TOTAL_STORAGE_PER_USER = 100 * 1024 * 1024; // 100 MB
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1536;
export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;
export const ZIP_BOMB_THRESHOLD = 200 * 1024 * 1024; // 200 MB streaming defense-in-depth
export const CATALOGUE_MAX_BYTES = 4096;
export const CATALOGUE_MAX_SKILLS = 20;
export const CATALOGUE_TRUNCATED_DESC_LENGTH = 256;

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
