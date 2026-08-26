import { QueryCommand, PutCommand, DeleteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import {
  Lesson,
  LessonCreatedBy,
  LessonStatus,
  MAX_LESSONS_PER_USER,
  LESSON_INJECTION_TOP_K,
  LESSON_RELEVANCE_THRESHOLD,
} from '../schema/lesson';
import { randomBytes } from 'crypto';
import { embedText, encodeEmbedding, decodeEmbedding, cosineSimilarity } from './embeddings';

/**
 * Lesson (memory) store. Lessons are durable, user-scoped notes captured from
 * user corrections / failures and injected into future sessions' system prompt
 * via semantic retrieval. Scoping mirrors skills and user-preferences
 * (PK = `lesson-<userId>`).
 *
 * ## Scope design note (global lessons — NOT implemented in v1)
 * A future extension could add deployment-global lessons (shared across all
 * users) under a separate partition key, and/or per-custom-agent scoping. v1
 * intentionally implements ONLY the user scope to stay aligned with skills /
 * user-preferences and to keep the edit surface (webapp) simple. Global scope
 * is left as a documented design hook, not code.
 */
const lessonPK = (userId: string) => `lesson-${userId}`;

export const getLesson = async (userId: string, lessonId: string): Promise<Lesson | undefined> => {
  const res = await ddb.send(
    new GetCommand({
      TableName,
      Key: { PK: lessonPK(userId), SK: lessonId },
    })
  );
  return res.Item as Lesson | undefined;
};

export const listLessons = async (userId: string): Promise<Lesson[]> => {
  // A lesson item can be large (embedding base64 ~5.5KB + body up to ~8KB), so a
  // single DDB Query page (max 1MB) holds only ~75-170 items — far fewer than
  // MAX_LESSONS_PER_USER (500). We MUST page through LastEvaluatedKey, otherwise
  // (a) the create-time cap could never be enforced past the first page and
  // (b) retrieval would silently drop older lessons (arbitrary SK truncation).
  const items: Lesson[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': lessonPK(userId) },
        ScanIndexForward: false,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    if (res.Items) items.push(...(res.Items as Lesson[]));
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
};

export const listActiveLessons = async (userId: string): Promise<Lesson[]> => {
  const all = await listLessons(userId);
  // Default status to 'active' for legacy items written before the field existed.
  return all.filter((l) => (l.status ?? 'active') === 'active');
};

export interface CreateLessonInput {
  content: string;
  category?: string;
  createdBy?: LessonCreatedBy;
  sourceSessionId?: string;
}

export const createLesson = async (userId: string, input: CreateLessonInput): Promise<Lesson> => {
  const existing = await listLessons(userId);
  if (existing.length >= MAX_LESSONS_PER_USER) {
    throw new Error(`MAX_LESSONS_EXCEEDED: Cannot create more than ${MAX_LESSONS_PER_USER} lessons`);
  }

  const now = Date.now();
  const id = randomBytes(6).toString('base64url');

  // Best-effort embedding — never blocks creation. A lesson without an
  // embedding is still stored, editable, and injectable via recency fallback.
  const vector = await embedText(input.content);

  const lesson: Lesson = {
    PK: lessonPK(userId),
    SK: id,
    content: input.content,
    category: input.category,
    status: 'active',
    createdBy: input.createdBy ?? 'agent',
    sourceSessionId: input.sourceSessionId,
    embedding: vector ? encodeEmbedding(vector) : undefined,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName, Item: lesson }));
  return lesson;
};

export interface UpdateLessonInput {
  content?: string;
  category?: string;
  status?: LessonStatus;
}

export const updateLesson = async (userId: string, lessonId: string, input: UpdateLessonInput): Promise<Lesson> => {
  const existing = await getLesson(userId, lessonId);
  if (!existing) {
    throw new Error('LESSON_NOT_FOUND: Lesson does not exist.');
  }

  const now = Date.now();
  const setExpr: string[] = ['#updatedAt = :updatedAt'];
  const removeExpr: string[] = [];
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': now };

  if (input.content !== undefined) {
    setExpr.push('#content = :content');
    names['#content'] = 'content';
    values[':content'] = input.content;
    // Re-embed when the body changes (best-effort). On embedding failure we
    // REMOVE the stale vector rather than writing null: the schema types
    // `embedding` as an optional string, and a stale vector must never be used
    // for ranking a body it no longer matches. Note the consequence: while any
    // OTHER active lesson still has an embedding, semantic ranking is used and
    // this now-embeddingless lesson is excluded from retrieval entirely (it is
    // only picked up by the recency fallback, which fires only when NO lesson
    // has an embedding). Re-running Update with content restores its embedding.
    const vector = await embedText(input.content);
    if (vector) {
      setExpr.push('#embedding = :embedding');
      names['#embedding'] = 'embedding';
      values[':embedding'] = encodeEmbedding(vector);
    } else {
      removeExpr.push('#embedding');
      names['#embedding'] = 'embedding';
    }
  }
  if (input.category !== undefined) {
    setExpr.push('#category = :category');
    names['#category'] = 'category';
    values[':category'] = input.category;
  }
  if (input.status !== undefined) {
    setExpr.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = input.status;
  }

  const updateExpression = [`SET ${setExpr.join(', ')}`, removeExpr.length ? `REMOVE ${removeExpr.join(', ')}` : '']
    .filter(Boolean)
    .join(' ');

  const res = await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: lessonPK(userId), SK: lessonId },
      ConditionExpression: 'attribute_exists(PK)',
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    })
  );
  return res.Attributes as Lesson;
};

export const deleteLesson = async (userId: string, lessonId: string): Promise<void> => {
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: { PK: lessonPK(userId), SK: lessonId },
    })
  );
};

export interface RankedLesson {
  lesson: Lesson;
  score: number;
}

/**
 * Retrieve the lessons most relevant to `queryText` for injection into the
 * system prompt.
 *
 * Strategy:
 *  1. Load all active lessons (paged, bounded by MAX_LESSONS_PER_USER).
 *  2. If NO lesson has a stored embedding, skip embedding entirely and fall
 *     back to recency (avoids a wasted Bedrock call).
 *  3. Otherwise embed the query (single Bedrock call). If it succeeds, rank by
 *     cosine similarity and keep those above LESSON_RELEVANCE_THRESHOLD; if it
 *     fails (or the query is empty), fall back to the most-recently-updated.
 *
 * This function never throws — a store/embedding error yields an empty list so
 * the turn is never broken. topK defaults to LESSON_INJECTION_TOP_K.
 */
export const retrieveRelevantLessons = async (
  userId: string,
  queryText: string,
  topK: number = LESSON_INJECTION_TOP_K
): Promise<Lesson[]> => {
  let lessons: Lesson[];
  try {
    lessons = await listActiveLessons(userId);
  } catch (error) {
    console.warn('[lessons] Failed to load lessons for retrieval:', error);
    return [];
  }
  if (lessons.length === 0) return [];

  const byRecency = [...lessons].sort((a, b) => b.updatedAt - a.updatedAt);

  // Check for any stored embedding BEFORE embedding the query, so we skip the
  // (billed) Bedrock InvokeModel call entirely when semantic ranking is
  // impossible anyway (no lesson has a vector).
  const haveAnyEmbedding = lessons.some((l) => l.embedding);
  if (!haveAnyEmbedding) {
    // Graceful fallback: recency-ordered top-K.
    return byRecency.slice(0, topK);
  }

  const queryVector = queryText?.trim() ? await embedText(queryText) : undefined;
  if (!queryVector) {
    // Query embedding unavailable (empty query or embed failure) — recency fallback.
    return byRecency.slice(0, topK);
  }

  const ranked: RankedLesson[] = [];
  for (const lesson of lessons) {
    const vector = decodeEmbedding(lesson.embedding);
    if (!vector) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (score >= LESSON_RELEVANCE_THRESHOLD) {
      ranked.push({ lesson, score });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  const relevant = ranked.slice(0, topK).map((r) => r.lesson);

  // If semantic ranking found nothing above threshold, do NOT inject noise —
  // return empty rather than falling back to recency, so an unrelated task
  // does not get lessons forced into its prompt.
  return relevant;
};
