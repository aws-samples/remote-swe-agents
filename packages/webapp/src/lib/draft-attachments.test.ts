import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from './deployment-recovery';
import { clearDraftAttachments, loadDraftAttachments, saveDraftAttachments } from './draft-attachments';

function fakeStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('draft attachments persistence', () => {
  it('round-trips image and file keys', () => {
    const storage = fakeStorage();
    saveDraftAttachments('w1', { imageKeys: ['w1/a.png'], fileKeys: ['w1/b/doc.txt'] }, storage);
    expect(loadDraftAttachments('w1', storage)).toEqual({ imageKeys: ['w1/a.png'], fileKeys: ['w1/b/doc.txt'] });
  });

  it('is namespaced per session (worker id)', () => {
    const storage = fakeStorage();
    saveDraftAttachments('w1', { imageKeys: ['w1/a.png'], fileKeys: [] }, storage);
    expect(loadDraftAttachments('w2', storage)).toBeNull();
    expect(storage.getItem('draft-attachments-w1')).not.toBeNull();
  });

  it('removes the entry when both key sets are empty (send-success clearing path)', () => {
    const storage = fakeStorage();
    saveDraftAttachments('w1', { imageKeys: ['w1/a.png'], fileKeys: [] }, storage);
    saveDraftAttachments('w1', { imageKeys: [], fileKeys: [] }, storage);
    expect(storage.getItem('draft-attachments-w1')).toBeNull();
    expect(loadDraftAttachments('w1', storage)).toBeNull();
  });

  it('clearDraftAttachments removes the entry', () => {
    const storage = fakeStorage();
    saveDraftAttachments('w1', { imageKeys: ['w1/a.png'], fileKeys: [] }, storage);
    clearDraftAttachments('w1', storage);
    expect(loadDraftAttachments('w1', storage)).toBeNull();
  });

  it('rejects corrupted payloads and filters non-string entries', () => {
    const storage = fakeStorage();
    storage.setItem('draft-attachments-w1', 'not json');
    expect(loadDraftAttachments('w1', storage)).toBeNull();
    storage.setItem('draft-attachments-w1', JSON.stringify({ imageKeys: ['ok', 42, null], fileKeys: 'nope' }));
    expect(loadDraftAttachments('w1', storage)).toEqual({ imageKeys: ['ok'], fileKeys: [] });
    storage.setItem('draft-attachments-w1', JSON.stringify({ imageKeys: [1], fileKeys: [] }));
    expect(loadDraftAttachments('w1', storage)).toBeNull();
  });

  it('is a no-op with unavailable storage', () => {
    expect(() => saveDraftAttachments('w1', { imageKeys: ['a'], fileKeys: [] }, null)).not.toThrow();
    expect(loadDraftAttachments('w1', null)).toBeNull();
    expect(() => clearDraftAttachments('w1', null)).not.toThrow();
  });
});
