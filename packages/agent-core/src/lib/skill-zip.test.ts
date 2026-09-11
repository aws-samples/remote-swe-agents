import { describe, expect, test } from 'vitest';
import { validateZipEntryPath } from './skill-zip';

describe('validateZipEntryPath', () => {
  test('accepts valid paths', () => {
    expect(validateZipEntryPath('SKILL.md')).toBe(true);
    expect(validateZipEntryPath('references/guide.md')).toBe(true);
    expect(validateZipEntryPath('a/b/c.txt')).toBe(true);
    expect(validateZipEntryPath('.gitkeep')).toBe(true);
  });

  test('rejects path traversal with ../', () => {
    expect(validateZipEntryPath('../etc/passwd')).toBe(false);
    expect(validateZipEntryPath('a/../../b')).toBe(false);
    expect(validateZipEntryPath('a/../b')).toBe(false);
  });

  test('rejects absolute paths', () => {
    expect(validateZipEntryPath('/etc/passwd')).toBe(false);
    expect(validateZipEntryPath('/tmp/test.md')).toBe(false);
  });

  test('rejects null bytes', () => {
    expect(validateZipEntryPath('file\0.md')).toBe(false);
    expect(validateZipEntryPath('\0')).toBe(false);
  });

  test('rejects hidden files (except .gitkeep)', () => {
    expect(validateZipEntryPath('.hidden')).toBe(false);
    expect(validateZipEntryPath('.env')).toBe(false);
    expect(validateZipEntryPath('dir/.secret')).toBe(false);
  });

  test('rejects empty path', () => {
    expect(validateZipEntryPath('')).toBe(false);
  });
});
