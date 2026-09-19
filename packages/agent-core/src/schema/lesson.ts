import { z } from 'zod';

/**
 * Maximum number of lessons a single user may persist. Keeps the per-user
 * retrieval scan (which loads all active lessons into memory for cosine
 * similarity ranking) bounded and cheap.
 */
export const MAX_LESSONS_PER_USER = 500;

/** Maximum length (characters) of a single lesson body. */
export const MAX_LESSON_CONTENT_LENGTH = 2000;

/** Maximum length (characters) of the optional category label. */
export const MAX_LESSON_CATEGORY_LENGTH = 64;

/**
 * Number of lessons injected into the system prompt per turn. Chosen to keep
 * the injected block small (topK * body-size cap) so the "## Learned Lessons"
 * section never bloats the context window.
 */
export const LESSON_INJECTION_TOP_K = 5;

/**
 * Minimum cosine similarity for a lesson to be considered relevant enough to
 * inject. Lessons below this threshold are dropped so unrelated tasks do not
 * get noise forced into their prompt.
 */
export const LESSON_RELEVANCE_THRESHOLD = 0.3;

/**
 * Per-lesson body clip (characters) applied ONLY when rendering the injected
 * block. The stored body may be longer (up to MAX_LESSON_CONTENT_LENGTH); the
 * rendered form is clipped so a few long lessons cannot dominate the prompt.
 */
export const LESSON_INJECTION_MAX_BODY_LENGTH = 400;

/**
 * Hard byte cap on the total rendered "## Learned Lessons" block. Defence in
 * depth against many lessons blowing the token budget even within topK.
 */
export const LESSON_INJECTION_MAX_BYTES = 3072;

/**
 * Embedding model + dimensionality. Titan Text Embeddings v2 is a single,
 * cheap InvokeModel call, independent of the conversation inference path
 * (which may be kiro-cli). 1024 dims is the model default.
 *
 * This is the single source of truth for the DEFAULT model id; `lib/embeddings.ts`
 * imports it and allows an `EMBEDDING_MODEL_ID` env override on top.
 */
export const LESSON_EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
export const LESSON_EMBEDDING_DIMENSIONS = 1024;

export const lessonStatusSchema = z.enum(['active', 'archived']);
export type LessonStatus = z.infer<typeof lessonStatusSchema>;

export const lessonCreatedBySchema = z.enum(['agent', 'user']);
export type LessonCreatedBy = z.infer<typeof lessonCreatedBySchema>;

export const lessonSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  /** The durable lesson text (what was learned from a correction / failure). */
  content: z.string().min(1).max(MAX_LESSON_CONTENT_LENGTH),
  /** Optional free-form category label for grouping (e.g. in a future management UI). */
  category: z.string().max(MAX_LESSON_CATEGORY_LENGTH).optional(),
  /*
   * SCOPE (design note, intentionally NOT a field in v1): lessons are scoped
   * per-user via the partition key `lesson-<userId>`. Deployment-wide 'global'
   * scope was considered but deliberately left unimplemented — if added later
   * it would become an explicit attribute here plus a second query in
   * retrieveRelevantLessons. Keeping it out of the schema now avoids a dead
   * required field.
   */
  /** Where the lesson originated. */
  createdBy: lessonCreatedBySchema.default('agent'),
  /** Session that produced the lesson (for traceability). */
  sourceSessionId: z.string().optional(),
  /** 'active' lessons are eligible for injection; 'archived' are hidden. */
  status: lessonStatusSchema.default('active'),
  /**
   * base64-encoded Float32Array of the content embedding. Stored compactly to
   * stay well under the 400KB DynamoDB item limit. May be absent when the
   * embedding call failed at write time (lesson still usable, just not
   * semantically retrievable — falls back to recency).
   */
  embedding: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Lesson = z.infer<typeof lessonSchema>;
