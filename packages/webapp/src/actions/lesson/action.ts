'use server';

import { authActionClient, MyCustomError } from '@/lib/safe-action';
import {
  listLessons as listLessonsDb,
  getLesson,
  createLesson,
  updateLesson,
  deleteLesson,
} from '@remote-swe-agents/agent-core/lib';
import {
  Lesson,
  lessonStatusSchema,
  MAX_LESSON_CONTENT_LENGTH,
  MAX_LESSON_CATEGORY_LENGTH,
} from '@remote-swe-agents/agent-core/schema';
import { z } from 'zod';

// The stored embedding (base64 ~5.5KB/item) and PK are server-only. Strip them
// so they never bloat the RSC payload / cross the wire to the client.
export type ClientLesson = Omit<Lesson, 'embedding' | 'PK'>;

const toClientLesson = ({ embedding: _embedding, PK: _PK, ...rest }: Lesson): ClientLesson => rest;

export const listUserLessons = authActionClient.action(async ({ ctx }) => {
  const lessons = await listLessonsDb(ctx.userId);
  return lessons.sort((a, b) => b.updatedAt - a.updatedAt).map(toClientLesson);
});

const createLessonSchema = z.object({
  content: z.string().min(1).max(MAX_LESSON_CONTENT_LENGTH),
  category: z.string().max(MAX_LESSON_CATEGORY_LENGTH).optional(),
});

export const createUserLesson = authActionClient
  .inputSchema(createLessonSchema)
  .action(async ({ parsedInput, ctx }) => {
    try {
      const lesson = await createLesson(ctx.userId, {
        content: parsedInput.content,
        category: parsedInput.category || undefined,
        createdBy: 'user',
      });
      return toClientLesson(lesson);
    } catch (e) {
      throw new MyCustomError((e as Error).message);
    }
  });

const updateLessonSchema = z.object({
  lessonId: z.string(),
  content: z.string().min(1).max(MAX_LESSON_CONTENT_LENGTH).optional(),
  category: z.string().max(MAX_LESSON_CATEGORY_LENGTH).optional(),
  status: lessonStatusSchema.optional(),
});

export const updateUserLesson = authActionClient
  .inputSchema(updateLessonSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { lessonId, ...input } = parsedInput;
    try {
      const lesson = await updateLesson(ctx.userId, lessonId, input);
      return toClientLesson(lesson);
    } catch (e) {
      throw new MyCustomError((e as Error).message);
    }
  });

const deleteLessonSchema = z.object({
  lessonId: z.string(),
});

export const deleteUserLesson = authActionClient
  .inputSchema(deleteLessonSchema)
  .action(async ({ parsedInput, ctx }) => {
    const lesson = await getLesson(ctx.userId, parsedInput.lessonId);
    if (!lesson) {
      throw new MyCustomError('Lesson not found.');
    }
    await deleteLesson(ctx.userId, parsedInput.lessonId);
    return { success: true };
  });
