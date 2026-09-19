import { Lesson, LESSON_INJECTION_MAX_BODY_LENGTH, LESSON_INJECTION_MAX_BYTES } from '../schema/lesson';

/**
 * Render the "## Learned Lessons" system-prompt block from a set of already
 * ranked/selected lessons. Applies a per-lesson body clip and an overall byte
 * budget so the injected block can never blow up prompt token usage.
 *
 * Returns an empty string when there are no lessons (caller then injects
 * nothing). Pure function — no I/O — so it is trivially testable.
 */
export const buildLessonsBlock = (lessons: Lesson[]): string => {
  if (!lessons || lessons.length === 0) return '';

  const header = `## Learned Lessons

Durable lessons learned from past corrections and mistakes for this user. Apply them proactively; they reflect the user's preferences and prior feedback. If a lesson conflicts with an explicit current instruction, follow the current instruction.
`;

  let block = header;
  let currentSize = Buffer.byteLength(block, 'utf8');
  let rendered = 0;

  for (const lesson of lessons) {
    let body = (lesson.content ?? '').replace(/\r?\n/g, ' ').trim();
    if (body.length === 0) continue;
    if (body.length > LESSON_INJECTION_MAX_BODY_LENGTH) {
      body = body.slice(0, LESSON_INJECTION_MAX_BODY_LENGTH - 3) + '...';
    }
    // Sanitize the category the same way as the body: collapse newlines to
    // spaces so a category containing "\n## " cannot inject a fake heading
    // into the system prompt.
    const category = (lesson.category ?? '').replace(/\r?\n/g, ' ').trim();
    const prefix = category ? `[${category}] ` : '';
    const row = `- ${prefix}${body}\n`;
    const rowSize = Buffer.byteLength(row, 'utf8');
    if (currentSize + rowSize > LESSON_INJECTION_MAX_BYTES) break;
    block += row;
    currentSize += rowSize;
    rendered++;
  }

  // If the budget was so tight that no lesson row fit, emit nothing rather
  // than a dangling header.
  if (rendered === 0) return '';

  return block.trimEnd();
};
