import { describe, expect, test } from 'vitest';
import { imageFormatFromKey } from './images';

describe('imageFormatFromKey', () => {
  test('extracts format from common S3 key extensions', () => {
    expect(imageFormatFromKey('worker/abc.png')).toBe('png');
    expect(imageFormatFromKey('worker/abc.jpeg')).toBe('jpeg');
    expect(imageFormatFromKey('worker/abc.webp')).toBe('webp');
    expect(imageFormatFromKey('worker/abc.gif')).toBe('gif');
  });

  test('normalises .jpg alias to jpeg', () => {
    expect(imageFormatFromKey('worker/abc.jpg')).toBe('jpeg');
  });

  test('is case-insensitive', () => {
    expect(imageFormatFromKey('worker/abc.PNG')).toBe('png');
    expect(imageFormatFromKey('worker/abc.JPEG')).toBe('jpeg');
  });

  test('returns undefined for unrecognised / unsupported formats', () => {
    expect(imageFormatFromKey('worker/abc.svg')).toBeUndefined();
    expect(imageFormatFromKey('worker/abc.tiff')).toBeUndefined();
    expect(imageFormatFromKey('worker/abc.bmp')).toBeUndefined();
  });

  test('returns undefined when there is no extension', () => {
    expect(imageFormatFromKey('worker/abc')).toBeUndefined();
    expect(imageFormatFromKey('')).toBeUndefined();
  });

  test('handles webapp_init keys (no workerId prefix)', () => {
    expect(imageFormatFromKey('webapp_init/deadbeef.png')).toBe('png');
  });

  test('uses extension (not hardcoded webp) — regression guard', () => {
    // Pre-fix, create-session.ts hardcoded 'webp' regardless of the key
    // extension. This test guards against that regression.
    expect(imageFormatFromKey('worker/abc.png')).not.toBe('webp');
    expect(imageFormatFromKey('worker/abc.jpeg')).not.toBe('webp');
  });
});
