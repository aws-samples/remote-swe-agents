import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { KeyValueStorage } from './deployment-recovery';
import {
  PENDING_RESEND_MAX_AGE_MS,
  extractStringArray,
  hasPendingResend,
  parsePendingResend,
  salvageOptionalFields,
  savePendingResend,
  takePendingResend,
} from './pending-resend';

function fakeStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

type Values = { message: string; imageKeys: string[]; fileKeys: string[] };

describe('pending resend persistence', () => {
  it('round-trips mode, values and clientId', () => {
    const storage = fakeStorage();
    const values: Values = { message: 'hello', imageKeys: ['w/1.png'], fileKeys: ['w/2/file.txt'] };
    savePendingResend('message-w', { mode: 'resend', values, clientId: 'abc-123' }, storage, 1000);
    const taken = takePendingResend<Values>('message-w', storage, 2000);
    expect(taken).not.toBeNull();
    expect(taken!.mode).toBe('resend');
    expect(taken!.values).toEqual(values);
    expect(taken!.clientId).toBe('abc-123');
  });

  it('round-trips restore mode', () => {
    const storage = fakeStorage();
    savePendingResend<Values>(
      'message-w',
      { mode: 'restore', values: { message: 'x', imageKeys: [], fileKeys: [] } },
      storage,
      1000
    );
    expect(takePendingResend<Values>('message-w', storage, 1001)!.mode).toBe('restore');
  });

  it('parses unknown or missing modes as restore (fail-safe: never auto-submit)', () => {
    expect(parsePendingResend(JSON.stringify({ savedAt: 1, values: { message: 'x' } }), 1000)!.mode).toBe('restore');
    expect(parsePendingResend(JSON.stringify({ savedAt: 1, values: { message: 'x' }, mode: 'yolo' }), 1000)!.mode).toBe(
      'restore'
    );
  });

  it('consumes the payload exactly once (double-send guard)', () => {
    const storage = fakeStorage();
    savePendingResend<Values>(
      'message-w',
      { mode: 'resend', values: { message: 'x', imageKeys: [], fileKeys: [] } },
      storage,
      1000
    );
    expect(takePendingResend<Values>('message-w', storage, 1001)).not.toBeNull();
    expect(takePendingResend<Values>('message-w', storage, 1002)).toBeNull();
  });

  it('is namespaced per form id', () => {
    const storage = fakeStorage();
    savePendingResend<Values>(
      'message-a',
      { mode: 'resend', values: { message: 'a', imageKeys: [], fileKeys: [] } },
      storage,
      1000
    );
    expect(takePendingResend<Values>('message-b', storage, 1001)).toBeNull();
    expect(takePendingResend<Values>('message-a', storage, 1001)).not.toBeNull();
  });

  it('expires stale payloads', () => {
    const storage = fakeStorage();
    savePendingResend<Values>(
      'message-w',
      { mode: 'resend', values: { message: 'x', imageKeys: [], fileKeys: [] } },
      storage,
      1000
    );
    expect(takePendingResend<Values>('message-w', storage, 1000 + PENDING_RESEND_MAX_AGE_MS + 1)).toBeNull();
  });

  it('removes an expired payload from storage even when rejecting it', () => {
    const storage = fakeStorage();
    savePendingResend<Values>(
      'message-w',
      { mode: 'resend', values: { message: 'x', imageKeys: [], fileKeys: [] } },
      storage,
      1000
    );
    takePendingResend<Values>('message-w', storage, 1000 + PENDING_RESEND_MAX_AGE_MS + 1);
    expect(storage.getItem('pending-resend-message-w')).toBeNull();
  });

  it('rejects corrupted payloads', () => {
    expect(parsePendingResend('not json', 1000)).toBeNull();
    expect(parsePendingResend(JSON.stringify({ savedAt: 'nope', values: {} }), 1000)).toBeNull();
    expect(parsePendingResend(JSON.stringify({ savedAt: 1 }), 1000)).toBeNull();
    expect(parsePendingResend(JSON.stringify({ savedAt: 1, values: 'text' }), 1000)).toBeNull();
    expect(parsePendingResend(JSON.stringify({ savedAt: 1, values: null }), 1000)).toBeNull();
    expect(parsePendingResend(JSON.stringify({ savedAt: 1, values: {}, clientId: 42 }), 1000)).toBeNull();
    expect(parsePendingResend(null, 1000)).toBeNull();
  });

  it('is a no-op with unavailable storage', () => {
    expect(() =>
      savePendingResend<Values>('x', { mode: 'resend', values: { message: '', imageKeys: [], fileKeys: [] } }, null)
    ).not.toThrow();
    expect(takePendingResend<Values>('x', null)).toBeNull();
  });
});

describe('hasPendingResend (non-consuming peek)', () => {
  it('sees a stored payload without consuming it', () => {
    const storage = fakeStorage();
    savePendingResend<Values>(
      'message-w',
      { mode: 'resend', values: { message: 'x', imageKeys: [], fileKeys: [] } },
      storage,
      1000
    );
    expect(hasPendingResend('message-w', storage, 1001)).toBe(true);
    // Still consumable afterwards — the peek must not disturb the
    // take-before-submit invariant.
    expect(takePendingResend<Values>('message-w', storage, 1002)).not.toBeNull();
  });

  it('is false when nothing is stored, after consumption, and for expired payloads', () => {
    const storage = fakeStorage();
    expect(hasPendingResend('message-w', storage, 1000)).toBe(false);
    savePendingResend<Values>(
      'message-w',
      { mode: 'resend', values: { message: 'x', imageKeys: [], fileKeys: [] } },
      storage,
      1000
    );
    takePendingResend<Values>('message-w', storage, 1001);
    expect(hasPendingResend('message-w', storage, 1002)).toBe(false);
    savePendingResend<Values>(
      'message-w',
      { mode: 'resend', values: { message: 'x', imageKeys: [], fileKeys: [] } },
      storage,
      2000
    );
    expect(hasPendingResend('message-w', storage, 2000 + PENDING_RESEND_MAX_AGE_MS + 1)).toBe(false);
  });

  it('is false with unavailable storage', () => {
    expect(hasPendingResend('x', null)).toBe(false);
  });
});

describe('extractStringArray', () => {
  it('keeps only string entries', () => {
    expect(extractStringArray(['a', 1, null, 'b', {}])).toEqual(['a', 'b']);
  });

  it('returns an empty array for non-arrays', () => {
    expect(extractStringArray(undefined)).toEqual([]);
    expect(extractStringArray('a')).toEqual([]);
    expect(extractStringArray({ 0: 'a' })).toEqual([]);
  });
});

describe('salvageOptionalFields', () => {
  const shape = {
    modelOverride: z.enum(['sonnet', 'opus']).optional(),
    customAgentId: z.string().optional(),
    inferenceMode: z.enum(['bedrock', 'kiro-cli']).optional(),
  };

  it('drops only the fields that are actually invalid, keeping valid siblings', () => {
    const { values, dropped } = salvageOptionalFields(
      shape,
      { modelOverride: 'removed-model', customAgentId: 'agent-1', inferenceMode: 'kiro-cli' },
      ['modelOverride', 'customAgentId', 'inferenceMode']
    );
    expect(values).toEqual({ customAgentId: 'agent-1', inferenceMode: 'kiro-cli' });
    expect(dropped).toEqual(['modelOverride']);
  });

  it('keeps all valid fields and reports nothing dropped', () => {
    const { values, dropped } = salvageOptionalFields(shape, { modelOverride: 'opus', customAgentId: 'a' }, [
      'modelOverride',
      'customAgentId',
      'inferenceMode',
    ]);
    expect(values).toEqual({ modelOverride: 'opus', customAgentId: 'a' });
    expect(dropped).toEqual([]);
  });

  it('omits fields that parse to undefined (absent optionals are not dropped)', () => {
    const { values, dropped } = salvageOptionalFields(shape, {}, ['modelOverride', 'customAgentId']);
    expect(values).toEqual({});
    expect(dropped).toEqual([]);
  });
});
