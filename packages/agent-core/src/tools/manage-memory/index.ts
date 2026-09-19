import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { listLessons, getLesson, createLesson, updateLesson, deleteLesson } from '../../lib/lessons';
import { getSession } from '../../lib/sessions';
import {
  MAX_LESSON_CONTENT_LENGTH,
  MAX_LESSON_CATEGORY_LENGTH,
  MAX_LESSONS_PER_USER,
  lessonStatusSchema,
} from '../../schema/lesson';

const resolveUserId = async (workerId: string): Promise<string> => {
  const session = await getSession(workerId);
  if (!session?.initiator) {
    throw new Error('Could not determine user identity from session.');
  }
  return session.initiator.includes('#') ? session.initiator.split('#').pop()! : session.initiator;
};

const memoryManagementDescription = `Manage the durable lesson memory: list, get, create, update, or delete lessons.

Lessons are short, durable takeaways captured from user corrections and past failures. They persist across sessions and the most relevant ones are automatically injected into future sessions' system prompt via semantic (embedding) search.

WHEN TO CREATE A LESSON:
- The user corrects your approach, a preference, or a factual assumption in a way that should hold for future work.
- A failure reveals a durable constraint about this system/repo (a build/test gotcha, an environment quirk, a policy).

Write each lesson as a single self-contained, generalizable instruction — not a play-by-play of one conversation. Lessons are user-scoped and are managed with these tools. Prefer updating or deleting an existing lesson over creating a near-duplicate.`;

const listLessonsSchema = z.object({});
const getLessonSchema = z.object({
  lessonId: z.string().describe('The ID of the lesson to retrieve.'),
});
const createLessonSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(MAX_LESSON_CONTENT_LENGTH)
    .describe(
      `The lesson text: a single, self-contained, generalizable instruction (max ${MAX_LESSON_CONTENT_LENGTH} chars).`
    ),
  category: z
    .string()
    .max(MAX_LESSON_CATEGORY_LENGTH)
    .optional()
    .describe('Optional short category label (e.g. "git", "testing", "preferences").'),
});
const updateLessonSchema = z.object({
  lessonId: z.string().describe('The ID of the lesson to update.'),
  content: z.string().min(1).max(MAX_LESSON_CONTENT_LENGTH).optional().describe('New lesson text.'),
  category: z.string().max(MAX_LESSON_CATEGORY_LENGTH).optional().describe('New category label.'),
  status: lessonStatusSchema
    .optional()
    .describe('Set to "archived" to stop injecting this lesson without deleting it, or "active" to re-enable it.'),
});
const deleteLessonSchema = z.object({
  lessonId: z.string().describe('The ID of the lesson to delete.'),
});

export const listLessonsTool: ToolDefinition<z.infer<typeof listLessonsSchema>> = {
  name: 'listLessons',
  handler: async (_input, context) => {
    const userId = await resolveUserId(context.workerId);
    const lessons = await listLessons(userId);
    if (lessons.length === 0) return 'No lessons found.';
    const summary = lessons.map((l) => ({
      id: l.SK,
      content: l.content,
      category: l.category,
      status: l.status,
      createdBy: l.createdBy,
      createdAt: new Date(l.createdAt).toISOString(),
      updatedAt: new Date(l.updatedAt).toISOString(),
    }));
    return JSON.stringify(summary, null, 2);
  },
  schema: listLessonsSchema,
  toolSpec: async () => ({
    name: 'listLessons',
    description: `List all lessons for the current user.\n\n${memoryManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(listLessonsSchema) },
  }),
};

export const getLessonTool: ToolDefinition<z.infer<typeof getLessonSchema>> = {
  name: 'getLesson',
  handler: async (input, context) => {
    const userId = await resolveUserId(context.workerId);
    const lesson = await getLesson(userId, input.lessonId);
    if (!lesson) return `Lesson with ID "${input.lessonId}" not found.`;
    return JSON.stringify(
      {
        id: lesson.SK,
        content: lesson.content,
        category: lesson.category,
        status: lesson.status,
        createdBy: lesson.createdBy,
        sourceSessionId: lesson.sourceSessionId,
        createdAt: new Date(lesson.createdAt).toISOString(),
        updatedAt: new Date(lesson.updatedAt).toISOString(),
      },
      null,
      2
    );
  },
  schema: getLessonSchema,
  toolSpec: async () => ({
    name: 'getLesson',
    description: `Get details of a specific lesson by ID.\n\n${memoryManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(getLessonSchema) },
  }),
};

export const createLessonTool: ToolDefinition<z.infer<typeof createLessonSchema>> = {
  name: 'createLesson',
  handler: async (input, context) => {
    const userId = await resolveUserId(context.workerId);
    try {
      const lesson = await createLesson(userId, {
        content: input.content,
        category: input.category,
        createdBy: 'agent',
        sourceSessionId: context.workerId,
      });
      return `Lesson created successfully.\n- ID: ${lesson.SK}`;
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
  schema: createLessonSchema,
  toolSpec: async () => ({
    name: 'createLesson',
    description: `Create a new durable lesson. Its embedding is computed automatically for semantic retrieval. Max ${MAX_LESSONS_PER_USER} lessons per user.\n\n${memoryManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(createLessonSchema) },
  }),
};

export const updateLessonTool: ToolDefinition<z.infer<typeof updateLessonSchema>> = {
  name: 'updateLesson',
  handler: async (input, context) => {
    const userId = await resolveUserId(context.workerId);
    if (input.content === undefined && input.category === undefined && input.status === undefined) {
      return 'Error: Provide at least one of content, category, or status to update.';
    }
    try {
      const lesson = await updateLesson(userId, input.lessonId, {
        content: input.content,
        category: input.category,
        status: input.status,
      });
      return `Lesson updated successfully.\n- ID: ${lesson.SK}\n- Status: ${lesson.status}`;
    } catch (e) {
      const err = e as Error;
      // AWS SDK v3 surfaces the failed ConditionExpression via the error
      // NAME, not the message text (message is "The conditional request
      // failed"). Match on name so the "not found" branch actually fires.
      if (err.name === 'ConditionalCheckFailedException') {
        return `Error: Lesson with ID "${input.lessonId}" not found.`;
      }
      return `Error: ${err.message}`;
    }
  },
  schema: updateLessonSchema,
  toolSpec: async () => ({
    name: 'updateLesson',
    description: `Update a lesson's content, category, or status. Changing content recomputes its embedding.\n\n${memoryManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(updateLessonSchema) },
  }),
};

export const deleteLessonTool: ToolDefinition<z.infer<typeof deleteLessonSchema>> = {
  name: 'deleteLesson',
  handler: async (input, context) => {
    const userId = await resolveUserId(context.workerId);
    const lesson = await getLesson(userId, input.lessonId);
    if (!lesson) return `Lesson with ID "${input.lessonId}" not found.`;
    await deleteLesson(userId, input.lessonId);
    return `Lesson (ID: ${input.lessonId}) deleted successfully.`;
  },
  schema: deleteLessonSchema,
  toolSpec: async () => ({
    name: 'deleteLesson',
    description: `Delete a lesson by ID. To keep it but stop injecting it, use updateLesson with status="archived" instead.\n\n${memoryManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(deleteLessonSchema) },
  }),
};
