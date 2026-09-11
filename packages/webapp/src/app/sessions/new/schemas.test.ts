import { describe, expect, test } from 'vitest';
import { createNewWorkerSchema } from './schemas';

// These tests pin the runtime behaviour of the `optionalEnum` helper after the
// `.optional()` wrapping added to fix the react-hook-form Control type
// mismatch (TS2322 on `control={control}`). The wrapping must NOT change
// parsing behaviour: empty strings still normalise to undefined, omitted
// fields stay undefined, valid enums pass, invalid enums are rejected.
describe('createNewWorkerSchema optionalEnum behaviour', () => {
  test('empty string modelOverride normalises to undefined (not a validation error)', () => {
    const r = createNewWorkerSchema.safeParse({ message: 'hi', modelOverride: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.modelOverride).toBeUndefined();
  });

  test('omitted modelOverride stays undefined', () => {
    const r = createNewWorkerSchema.safeParse({ message: 'hi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.modelOverride).toBeUndefined();
  });

  test('valid enum value passes through', () => {
    const r = createNewWorkerSchema.safeParse({ message: 'hi', modelOverride: 'opus5' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.modelOverride).toBe('opus5');
  });

  test('invalid enum value is rejected', () => {
    const r = createNewWorkerSchema.safeParse({ message: 'hi', modelOverride: 'not-a-real-model' });
    expect(r.success).toBe(false);
  });

  test('empty string inferenceMode / kiroDefaultModel also normalise to undefined', () => {
    const r = createNewWorkerSchema.safeParse({ message: 'hi', inferenceMode: '', kiroDefaultModel: '' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.inferenceMode).toBeUndefined();
      expect(r.data.kiroDefaultModel).toBeUndefined();
    }
  });
});
