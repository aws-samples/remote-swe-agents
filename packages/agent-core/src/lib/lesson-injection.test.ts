import { describe, expect, it } from 'vitest';
import { buildLessonsBlock } from './lesson-injection';
import { Lesson, LESSON_INJECTION_MAX_BODY_LENGTH, LESSON_INJECTION_MAX_BYTES } from '../schema/lesson';

const makeLesson = (overrides: Partial<Lesson> = {}): Lesson => ({
  PK: 'lesson-user1',
  SK: 'abc123',
  content: 'Always prefer feature branches with a timestamp suffix.',
  status: 'active',
  createdBy: 'agent',
  createdAt: 1000,
  updatedAt: 2000,
  ...overrides,
});

describe('buildLessonsBlock', () => {
  it('returns empty string for no lessons', () => {
    expect(buildLessonsBlock([])).toBe('');
    // @ts-expect-error defensive: undefined is handled at runtime
    expect(buildLessonsBlock(undefined)).toBe('');
  });

  it('renders a header and one row per lesson', () => {
    const block = buildLessonsBlock([makeLesson({ content: 'Lesson one.' }), makeLesson({ content: 'Lesson two.' })]);
    expect(block).toContain('## Learned Lessons');
    expect(block).toContain('- Lesson one.');
    expect(block).toContain('- Lesson two.');
  });

  it('prefixes the category when present', () => {
    const block = buildLessonsBlock([makeLesson({ category: 'git', content: 'Rebase feature branches.' })]);
    expect(block).toContain('- [git] Rebase feature branches.');
  });

  it('collapses newlines in the body to single spaces', () => {
    const block = buildLessonsBlock([makeLesson({ content: 'line1\nline2\r\nline3' })]);
    expect(block).toContain('- line1 line2 line3');
    // The rendered row must be single-line (no embedded newline inside the body).
    const bodyLine = block.split('\n').find((l) => l.startsWith('- line1'))!;
    expect(bodyLine).toBe('- line1 line2 line3');
  });

  it('skips lessons whose body is empty after trimming', () => {
    const block = buildLessonsBlock([makeLesson({ content: '   ' }), makeLesson({ content: 'Real lesson.' })]);
    expect(block).toContain('- Real lesson.');
    expect(block).not.toMatch(/-\s*\n/);
  });

  it('clips an over-long body to the injection cap with an ellipsis', () => {
    const longBody = 'x'.repeat(LESSON_INJECTION_MAX_BODY_LENGTH + 200);
    const block = buildLessonsBlock([makeLesson({ content: longBody })]);
    expect(block).toContain('...');
    expect(block).not.toContain(longBody);
    const bodyLine = block.split('\n').find((l) => l.startsWith('- x'))!;
    // "- " prefix + clipped body (which itself is <= MAX_BODY_LENGTH incl. ellipsis).
    expect(bodyLine.length).toBeLessThanOrEqual(2 + LESSON_INJECTION_MAX_BODY_LENGTH);
  });

  it('never exceeds the overall byte budget even with many lessons', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      makeLesson({ SK: `sk${i}`, content: 'A'.repeat(LESSON_INJECTION_MAX_BODY_LENGTH) })
    );
    const block = buildLessonsBlock(many);
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(LESSON_INJECTION_MAX_BYTES);
  });

  it('stops adding rows once the byte budget would be exceeded (drops later rows, keeps earlier ones)', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      makeLesson({ SK: `sk${i}`, content: `L${i} ` + 'A'.repeat(LESSON_INJECTION_MAX_BODY_LENGTH) })
    );
    const block = buildLessonsBlock(many);
    // First lesson fits; the 100th cannot possibly fit under the byte cap.
    expect(block).toContain('- L0 ');
    expect(block).not.toContain('- L99 ');
  });

  it('sanitizes a category with newlines so it cannot inject a fake heading', () => {
    const block = buildLessonsBlock([
      makeLesson({ category: 'git\n## Injected Heading\nmore', content: 'real lesson body' }),
    ]);
    // No line other than the legitimate block header may start with "## ".
    const injectedHeadings = block.split('\n').filter((l, i) => i > 0 && l.startsWith('## '));
    expect(injectedHeadings).toEqual([]);
    expect(block).toContain('[git ## Injected Heading more] real lesson body');
  });
});
