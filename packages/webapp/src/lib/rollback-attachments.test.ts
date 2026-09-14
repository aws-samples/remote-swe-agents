import { describe, expect, test } from 'vitest';
import { fallbackKeysForFailedLookup, planRollbackImageRestore, TakenOverImage } from './rollback-attachments';

const img = (n: number): TakenOverImage => ({ key: `w/img-${n}.png`, previewUrl: `blob:https://example/${n}` });

describe('rollback attachment recovery invariant', () => {
  test('partition never loses a key: live keys + revoked keys == snapshot', () => {
    const images = [img(1), img(2), img(3)];
    const usable = new Set([images[0].previewUrl, images[2].previewUrl]);
    const { liveImages, revokedImageKeys } = planRollbackImageRestore(images, (url) => usable.has(url));
    expect(liveImages.map((i) => i.key)).toEqual(['w/img-1.png', 'w/img-3.png']);
    expect(revokedImageKeys).toEqual(['w/img-2.png']);
    expect([...liveImages.map((i) => i.key), ...revokedImageKeys].sort()).toEqual(images.map((i) => i.key).sort());
  });

  test('W-A: lookup failure (null) keeps EVERY revoked key via key-only fallback', () => {
    const revoked = ['w/a.png', 'w/b.png'];
    expect(fallbackKeysForFailedLookup(revoked, null)).toEqual(revoked);
  });

  test('successful lookup needs no fallback (restorable subset re-enters the uploader; S3-missing keys are toasted, a legitimate drop)', () => {
    const revoked = ['w/a.png', 'w/b.png'];
    expect(fallbackKeysForFailedLookup(revoked, { imageKeys: ['w/a.png'], fileKeys: [] })).toEqual([]);
    expect(fallbackKeysForFailedLookup(revoked, { imageKeys: [], fileKeys: [] })).toEqual([]);
  });

  test('INVARIANT: for every lookup outcome, no still-existing key silently disappears', () => {
    const images = [img(1), img(2), img(3), img(4)];
    const usable = new Set([images[0].previewUrl]); // 2,3,4 already revoked
    const { liveImages, revokedImageKeys } = planRollbackImageRestore(images, (url) => usable.has(url));

    // Outcome A: lookup failed → live + fallback covers the full snapshot.
    const fallbackA = fallbackKeysForFailedLookup(revokedImageKeys, null);
    const survivedA = new Set([...liveImages.map((i) => i.key), ...fallbackA]);
    images.forEach((i) => expect(survivedA.has(i.key)).toBe(true));

    // Outcome B: lookup succeeded, one key gone from S3 → everything that
    // still exists survives (via restore), and the S3-deleted key is the
    // only drop (surfaced to the user by restoreFromKeys' toast).
    const restoredB = { imageKeys: ['w/img-2.png', 'w/img-3.png'], fileKeys: [] };
    const fallbackB = fallbackKeysForFailedLookup(revokedImageKeys, restoredB);
    const survivedB = new Set([...liveImages.map((i) => i.key), ...restoredB.imageKeys, ...fallbackB]);
    expect(survivedB.has('w/img-1.png')).toBe(true);
    expect(survivedB.has('w/img-2.png')).toBe(true);
    expect(survivedB.has('w/img-3.png')).toBe(true);
    expect(survivedB.has('w/img-4.png')).toBe(false); // deleted server-side, toasted
  });
});
