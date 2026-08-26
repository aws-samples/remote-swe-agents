import { describe, expect, it } from 'vitest';
import { encodeEmbedding, decodeEmbedding, cosineSimilarity } from './embeddings';

describe('encodeEmbedding / decodeEmbedding', () => {
  it('round-trips a vector through base64 Float32 with float32 precision', () => {
    const vector = [0.1, -0.5, 1.0, 0, 0.123456];
    const encoded = encodeEmbedding(vector);
    expect(typeof encoded).toBe('string');
    const decoded = decodeEmbedding(encoded);
    expect(decoded).toBeDefined();
    expect(decoded!.length).toBe(vector.length);
    for (let i = 0; i < vector.length; i++) {
      // Float32 round-trip loses precision vs the JS float64 input.
      expect(decoded![i]).toBeCloseTo(vector[i], 5);
    }
  });

  it('decodes undefined / empty input to undefined', () => {
    expect(decodeEmbedding(undefined)).toBeUndefined();
    expect(decodeEmbedding('')).toBeUndefined();
  });

  it('returns undefined for a buffer whose byte length is not a multiple of 4', () => {
    // "AAA" base64-decodes to 2 bytes, which is not a valid Float32 buffer.
    const notMultipleOf4 = Buffer.from([1, 2, 3]).toString('base64');
    expect(decodeEmbedding(notMultipleOf4)).toBeUndefined();
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical (normalized) vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('is scale-invariant (magnitude does not change the cosine)', () => {
    expect(cosineSimilarity([2, 0], [1, 0])).toBeCloseTo(1, 6);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 when one vector is all zeros (avoids divide-by-zero)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
