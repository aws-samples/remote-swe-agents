import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LESSON_INJECTION_TOP_K, LESSON_RELEVANCE_THRESHOLD } from '../schema/lesson';

const mockSend = vi.fn();
const mockEmbedText = vi.fn();

vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
}));

// Mock ONLY the external Bedrock embedding call (`embedText`). The encode /
// decode / cosineSimilarity helpers used by retrieveRelevantLessons stay REAL
// so the ranking path is exercised end-to-end against production code.
vi.mock('./embeddings', async (importOriginal) => {
  const original = await importOriginal<typeof import('./embeddings')>();
  return {
    ...original,
    embedText: (...args: any[]) => mockEmbedText(...args),
  };
});

import { retrieveRelevantLessons, updateLesson, listLessons } from './lessons';
import { encodeEmbedding } from './embeddings';

type StoredLesson = {
  PK: string;
  SK: string;
  content: string;
  status?: 'active' | 'archived';
  createdBy?: 'agent' | 'user';
  createdAt: number;
  updatedAt: number;
  embedding?: string;
};

const lesson = (over: Partial<StoredLesson> & { SK: string }): StoredLesson => ({
  PK: 'lesson-user1',
  content: 'some lesson',
  status: 'active',
  createdBy: 'agent',
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

/** Make listLessons (a Query) resolve to the given items. */
const mockQueryReturns = (items: StoredLesson[]) => {
  mockSend.mockResolvedValueOnce({ Items: items });
};

describe('retrieveRelevantLessons', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockEmbedText.mockReset();
  });

  it('returns [] when the user has no lessons', async () => {
    mockQueryReturns([]);
    const res = await retrieveRelevantLessons('user1', 'anything');
    expect(res).toEqual([]);
    // No embedding call needed when there are no lessons.
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it('returns [] (never throws) when the DDB query fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('ddb down'));
    const res = await retrieveRelevantLessons('user1', 'anything');
    expect(res).toEqual([]);
  });

  it('excludes archived lessons from retrieval', async () => {
    mockQueryReturns([
      lesson({ SK: 'a', status: 'archived', content: 'archived one', updatedAt: 5000 }),
      lesson({ SK: 'b', status: 'active', content: 'active one', updatedAt: 4000 }),
    ]);
    // Force the recency fallback: no query embedding.
    mockEmbedText.mockResolvedValueOnce(undefined);
    const res = await retrieveRelevantLessons('user1', 'query');
    expect(res.map((l) => l.SK)).toEqual(['b']);
  });

  it('falls back to most-recently-updated lessons when the query embedding is unavailable', async () => {
    mockQueryReturns([
      lesson({ SK: 'old', updatedAt: 1000 }),
      lesson({ SK: 'new', updatedAt: 9000 }),
      lesson({ SK: 'mid', updatedAt: 5000 }),
    ]);
    mockEmbedText.mockResolvedValueOnce(undefined); // embedding failed / disabled
    const res = await retrieveRelevantLessons('user1', 'query', 2);
    expect(res.map((l) => l.SK)).toEqual(['new', 'mid']);
  });

  it('falls back to recency AND skips the Bedrock call when NO stored lesson has an embedding', async () => {
    mockQueryReturns([lesson({ SK: 'a', updatedAt: 1000 }), lesson({ SK: 'b', updatedAt: 2000 })]);
    const res = await retrieveRelevantLessons('user1', 'query');
    // No lesson has an embedding → recency fallback, and the query embed is
    // skipped entirely (cost optimization: haveAnyEmbedding checked first).
    expect(res.map((l) => l.SK)).toEqual(['b', 'a']);
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it('ranks by cosine similarity and drops lessons below the relevance threshold', async () => {
    mockQueryReturns([
      lesson({ SK: 'match', embedding: encodeEmbedding([1, 0, 0]) }),
      lesson({ SK: 'orthogonal', embedding: encodeEmbedding([0, 1, 0]) }),
      lesson({ SK: 'near', embedding: encodeEmbedding([0.9, 0.1, 0]) }),
    ]);
    mockEmbedText.mockResolvedValueOnce([1, 0, 0]);
    const res = await retrieveRelevantLessons('user1', 'query');
    // 'orthogonal' has cosine 0 < threshold and must be excluded.
    expect(res.map((l) => l.SK)).not.toContain('orthogonal');
    // Best match ranked first.
    expect(res[0].SK).toBe('match');
    // Everything returned is above threshold.
    expect(res.length).toBeGreaterThanOrEqual(1);
  });

  it('returns [] when semantic ranking finds nothing above threshold (no recency noise)', async () => {
    mockQueryReturns([lesson({ SK: 'orthogonal', embedding: encodeEmbedding([0, 1, 0]) })]);
    mockEmbedText.mockResolvedValueOnce([1, 0, 0]);
    const res = await retrieveRelevantLessons('user1', 'query');
    expect(res).toEqual([]);
  });

  it('respects the topK limit', async () => {
    const items = Array.from({ length: LESSON_INJECTION_TOP_K + 5 }, (_, i) =>
      lesson({ SK: `s${i}`, embedding: encodeEmbedding([1, 0, 0]) })
    );
    mockQueryReturns(items);
    mockEmbedText.mockResolvedValueOnce([1, 0, 0]);
    const res = await retrieveRelevantLessons('user1', 'query');
    expect(res.length).toBeLessThanOrEqual(LESSON_INJECTION_TOP_K);
  });

  it('honors an explicit topK argument in the recency fallback', async () => {
    mockQueryReturns([
      lesson({ SK: 'a', updatedAt: 3000 }),
      lesson({ SK: 'b', updatedAt: 2000 }),
      lesson({ SK: 'c', updatedAt: 1000 }),
    ]);
    mockEmbedText.mockResolvedValueOnce(undefined);
    const res = await retrieveRelevantLessons('user1', 'query', 1);
    expect(res.map((l) => l.SK)).toEqual(['a']);
  });

  it('sanity: relevance threshold constant is within (0,1)', () => {
    expect(LESSON_RELEVANCE_THRESHOLD).toBeGreaterThan(0);
    expect(LESSON_RELEVANCE_THRESHOLD).toBeLessThan(1);
  });
});

/**
 * Regression coverage: on a content update whose re-embed fails, updateLesson
 * must REMOVE the (now stale) embedding attribute rather than writing `null`
 * (the schema types embedding as an optional string; null would be an invalid
 * shape and would also be treated as a truthy "has embedding" by a naive read).
 * These tests execute the real updateLesson and inspect the UpdateCommand it
 * builds; only the DDB client and the Bedrock embed call are mocked.
 */
describe('updateLesson embedding handling', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockEmbedText.mockReset();
  });

  const setupExistingLessonThenCaptureUpdate = () => {
    // 1st send = GetCommand (existence check), 2nd send = UpdateCommand.
    mockSend.mockResolvedValueOnce({ Item: lesson({ SK: 'l1', embedding: encodeEmbedding([1, 0, 0]) }) });
    mockSend.mockResolvedValueOnce({ Attributes: lesson({ SK: 'l1' }) });
  };

  it('REMOVEs the embedding (never writes null) when re-embed fails on content change', async () => {
    setupExistingLessonThenCaptureUpdate();
    mockEmbedText.mockResolvedValueOnce(undefined); // embed failure

    await updateLesson('user1', 'l1', { content: 'new body' });

    const updateCall = mockSend.mock.calls[1][0];
    const input = updateCall.input;
    expect(input.UpdateExpression).toContain('REMOVE');
    expect(input.UpdateExpression).toMatch(/REMOVE .*#embedding/);
    // Must NOT set embedding to null.
    expect(input.ExpressionAttributeValues?.[':embedding']).toBeUndefined();
    expect(JSON.stringify(input.ExpressionAttributeValues)).not.toContain('null');
  });

  it('SETs the new embedding when re-embed succeeds on content change', async () => {
    setupExistingLessonThenCaptureUpdate();
    mockEmbedText.mockResolvedValueOnce([0, 1, 0]); // embed success

    await updateLesson('user1', 'l1', { content: 'new body' });

    const input = mockSend.mock.calls[1][0].input;
    expect(input.UpdateExpression).toContain('SET');
    expect(input.UpdateExpression).not.toContain('REMOVE');
    expect(input.ExpressionAttributeValues?.[':embedding']).toBe(encodeEmbedding([0, 1, 0]));
  });

  it('does not touch embedding when only status changes (no re-embed)', async () => {
    setupExistingLessonThenCaptureUpdate();

    await updateLesson('user1', 'l1', { status: 'archived' });

    const input = mockSend.mock.calls[1][0].input;
    expect(input.UpdateExpression).not.toContain('REMOVE');
    expect(input.ExpressionAttributeNames).not.toHaveProperty('#embedding');
    expect(mockEmbedText).not.toHaveBeenCalled();
  });
});

/**
 * Regression coverage: listLessons must page through ALL DDB Query pages via
 * LastEvaluatedKey. Lesson items are large enough that MAX_LESSONS_PER_USER (500)
 * spans multiple 1MB pages; a single-page read would silently drop older lessons
 * and defeat the create-time cap. These tests execute the real listLessons and
 * assert every page is fetched and concatenated.
 */
describe('listLessons pagination', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockEmbedText.mockReset();
  });

  it('follows LastEvaluatedKey across multiple pages and concatenates all items', async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [lesson({ SK: 'p1a' }), lesson({ SK: 'p1b' })],
        LastEvaluatedKey: { PK: 'x', SK: 'p1b' },
      })
      .mockResolvedValueOnce({ Items: [lesson({ SK: 'p2a' })], LastEvaluatedKey: { PK: 'x', SK: 'p2a' } })
      .mockResolvedValueOnce({ Items: [lesson({ SK: 'p3a' })] }); // no LastEvaluatedKey → last page

    const res = await listLessons('user1');

    expect(res.map((l) => l.SK)).toEqual(['p1a', 'p1b', 'p2a', 'p3a']);
    expect(mockSend).toHaveBeenCalledTimes(3);
    // 2nd/3rd calls must carry the ExclusiveStartKey from the prior page.
    expect(mockSend.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ PK: 'x', SK: 'p1b' });
    expect(mockSend.mock.calls[2][0].input.ExclusiveStartKey).toEqual({ PK: 'x', SK: 'p2a' });
  });

  it('stops after a single page when there is no LastEvaluatedKey', async () => {
    mockSend.mockResolvedValueOnce({ Items: [lesson({ SK: 'only' })] });
    const res = await listLessons('user1');
    expect(res.map((l) => l.SK)).toEqual(['only']);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input.ExclusiveStartKey).toBeUndefined();
  });
});
