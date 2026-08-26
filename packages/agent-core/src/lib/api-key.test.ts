import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('./aws/ddb', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'test-table',
}));
vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'test-table',
}));

import { deriveApiKeyId, getApiKeySenderInfo } from './api-key';

describe('deriveApiKeyId', () => {
  test('returns a stable, deterministic id for the same key', () => {
    const k = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const a = deriveApiKeyId(k);
    const b = deriveApiKeyId(k);
    expect(a).toBe(b);
  });

  test('uses the apikey- prefix and a 12-char fingerprint', () => {
    const k = 'a'.repeat(64);
    const id = deriveApiKeyId(k);
    expect(id).toMatch(/^apikey-[0-9a-f]{12}$/);
  });

  test('NEVER leaks the raw secret in the derived id', () => {
    // Defence-in-depth test: even if a future change accidentally swaps
    // the SHA-256 fingerprint for the raw key, this test catches it.
    const secret = 'deadbeef'.repeat(8); // 64-char hex secret
    const id = deriveApiKeyId(secret);
    expect(id).not.toContain(secret);
    // Also must not contain a 16-char-or-longer prefix of the secret —
    // anything less than 16 chars is too short to recognize the key from
    // the fingerprint alone in practice.
    for (let i = 16; i <= secret.length; i++) {
      expect(id).not.toContain(secret.slice(0, i));
    }
  });

  test('different keys produce different ids', () => {
    expect(deriveApiKeyId('a'.repeat(64))).not.toBe(deriveApiKeyId('b'.repeat(64)));
  });
});

describe('getApiKeySenderInfo', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  test('returns null when the key does not exist (no Item)', async () => {
    mockSend.mockResolvedValueOnce({});
    const out = await getApiKeySenderInfo('missing-key');
    expect(out).toBeNull();
  });

  test('returns the description as displayName when the description is set', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        PK: 'api-key',
        SK: 'k1',
        LSI1: '0',
        createdAt: 0,
        description: 'CI deploy bot',
        ownerId: 'owner-1',
      },
    });
    const out = await getApiKeySenderInfo('k1');
    expect(out).not.toBeNull();
    expect(out!.displayName).toBe('CI deploy bot');
    expect(out!.ownerId).toBe('owner-1');
    expect(out!.id).toMatch(/^apikey-[0-9a-f]{12}$/);
  });

  test('falls back to the derived id when description is empty/whitespace', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        PK: 'api-key',
        SK: 'k2',
        LSI1: '0',
        createdAt: 0,
        description: '   ',
      },
    });
    const out = await getApiKeySenderInfo('k2');
    expect(out).not.toBeNull();
    expect(out!.displayName).toBe(out!.id);
    expect(out!.displayName).toMatch(/^apikey-[0-9a-f]{12}$/);
  });

  test('falls back to the derived id when description is missing', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { PK: 'api-key', SK: 'k3', LSI1: '0', createdAt: 0 },
    });
    const out = await getApiKeySenderInfo('k3');
    expect(out!.displayName).toBe(out!.id);
  });

  test('NEVER returns the raw key as displayName', async () => {
    // Even in degenerate cases where description / ownerId are missing,
    // the displayName must come from the derived id, not the secret.
    const secret = 'cafebabe'.repeat(8);
    mockSend.mockResolvedValueOnce({
      Item: { PK: 'api-key', SK: secret, LSI1: '0', createdAt: 0 },
    });
    const out = await getApiKeySenderInfo(secret);
    expect(out!.displayName).not.toContain(secret);
    expect(out!.id).not.toContain(secret);
  });
});
