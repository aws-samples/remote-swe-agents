/**
 * Image-dimension recovery helper tests (ported from the Bedrock loop).
 * These exercise the REAL exported helpers against a real temp HOME (no mock
 * simulation): the invalidate path deletes files on disk and is verified via
 * the SAME kiroV3SessionFilesExist / kiroV3SessionDir path helpers the
 * production loop uses (single source of truth).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  normalizeToolNameForComparison,
  isImageReadToolName,
  isImageDimensionError,
  invalidateKiroSessionFiles,
  extractImagePathFromToolInput,
} from './kiro-loop-helpers';
import { kiroV3SessionDir, kiroV3SessionFilesExist } from './kiro-session-synth';

// ---- normalizeToolNameForComparison (verbatim legacy port) -----------------
describe('normalizeToolNameForComparison (verbatim legacy port: strip space/underscore/hyphen + lowercase)', () => {
  test('ACP v3 display name "Read File" collapses to readfile', () => {
    expect(normalizeToolNameForComparison('Read File')).toBe('readfile');
  });
  test('snake_case read_file collapses to readfile', () => {
    expect(normalizeToolNameForComparison('read_file')).toBe('readfile');
  });
  test('fs_read / "Fs Read" collapse to fsread', () => {
    expect(normalizeToolNameForComparison('fs_read')).toBe('fsread');
    expect(normalizeToolNameForComparison('Fs Read')).toBe('fsread');
  });
  test('read_image / "Read Image" collapse to readimage', () => {
    expect(normalizeToolNameForComparison('read_image')).toBe('readimage');
    expect(normalizeToolNameForComparison('Read Image')).toBe('readimage');
  });
  test('"Read Local Image" / readLocalImage collapse to readlocalimage', () => {
    expect(normalizeToolNameForComparison('Read Local Image')).toBe('readlocalimage');
    expect(normalizeToolNameForComparison('readLocalImage')).toBe('readlocalimage');
  });
  test('hyphenated read-file collapses to readfile', () => {
    expect(normalizeToolNameForComparison('read-file')).toBe('readfile');
  });
});

describe('isImageReadToolName (gate uses the normalized IMAGE_READ_TOOL_NAMES values)', () => {
  test('display-name variants of the 4 known readers all gate true', () => {
    for (const name of [
      'Read File',
      'read_file',
      'Fs Read',
      'fs_read',
      'Read Image',
      'Read Local Image',
      'readLocalImage',
    ]) {
      expect(isImageReadToolName(name)).toBe(true);
    }
  });
  test('non-image tools gate false', () => {
    for (const name of ['executeBash', 'Execute Bash', 'write_file', 'grep']) {
      expect(isImageReadToolName(name)).toBe(false);
    }
  });
});

// ---- isImageDimensionError (broad recovery gate) ---------------------------
describe('isImageDimensionError (broad: dimensions+exceed / image+size / imagevalidationerror)', () => {
  test('image dimensions exceed maximum → true', () => {
    expect(isImageDimensionError('Image dimensions 8000x6000 exceed maximum allowed')).toBe(true);
  });
  test('image size phrasing → true', () => {
    expect(isImageDimensionError('The image size is too large')).toBe(true);
  });
  test('ImageValidationError token → true', () => {
    expect(isImageDimensionError('ValidationException: ImageValidationError raised')).toBe(true);
  });
  test('unrelated validation error → false', () => {
    expect(isImageDimensionError('invalid_request_error: bad tool schema')).toBe(false);
  });
});

// ---- extractImagePathFromToolInput -----------------------------------------
describe('extractImagePathFromToolInput', () => {
  test('explicit imagePath field is returned as-is', () => {
    expect(extractImagePathFromToolInput('readImage', { imagePath: '/tmp/a.png' })).toBe('/tmp/a.png');
  });
  test('path field with an image extension is returned', () => {
    expect(extractImagePathFromToolInput('readImage', { path: '/tmp/pic.jpeg' })).toBe('/tmp/pic.jpeg');
  });
  test('fs_read / read_file with an image path (path or filePath) is captured', () => {
    expect(extractImagePathFromToolInput('fs_read', { path: '/x/diagram.webp' })).toBe('/x/diagram.webp');
    expect(extractImagePathFromToolInput('Read File', { filePath: '/x/photo.gif' })).toBe('/x/photo.gif');
  });
  test('non-image file path → undefined (no capture)', () => {
    expect(extractImagePathFromToolInput('Read File', { path: '/x/notes.txt' })).toBeUndefined();
  });
  test('missing / non-object rawInput → undefined', () => {
    expect(extractImagePathFromToolInput('readImage', undefined)).toBeUndefined();
    expect(extractImagePathFromToolInput('readImage', 'nope')).toBeUndefined();
  });
});

// ---- invalidateKiroSessionFiles (real fs, path parity with the exist guard) -
describe('invalidateKiroSessionFiles (real fs; deletes exactly what kiroV3SessionFilesExist checks)', () => {
  let tmpHome: string;
  const cwd = '/tmp/some-workspace';
  const savedHome = process.env.HOME;

  beforeEach(async () => {
    tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kiro-invalidate-test-'));
    process.env.HOME = tmpHome;
  });
  afterEach(async () => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    await fs.promises.rm(tmpHome, { recursive: true, force: true });
  });

  test('deletes the v3 session dir that kiroV3SessionFilesExist inspects', () => {
    const sessionId = 'sess-abc123';
    const v3Dir = kiroV3SessionDir(sessionId, cwd, tmpHome);
    fs.mkdirSync(v3Dir, { recursive: true });
    fs.writeFileSync(path.join(v3Dir, 'session.json'), '{}');
    fs.writeFileSync(path.join(v3Dir, 'messages.jsonl'), '');
    // Precondition: the exist guard sees the session.
    expect(kiroV3SessionFilesExist(sessionId, cwd, tmpHome)).toBe(true);

    invalidateKiroSessionFiles(sessionId, cwd);

    // The guard now reports the session gone → re-synthesis will fire next.
    expect(kiroV3SessionFilesExist(sessionId, cwd, tmpHome)).toBe(false);
    expect(fs.existsSync(v3Dir)).toBe(false);
  });

  test('deletes v2 layout json + jsonl', () => {
    const sessionId = 'sess-v2-1';
    const v2Dir = path.join(tmpHome, '.kiro', 'sessions', 'cli');
    fs.mkdirSync(v2Dir, { recursive: true });
    const jsonPath = path.join(v2Dir, `${sessionId}.json`);
    const jsonlPath = path.join(v2Dir, `${sessionId}.jsonl`);
    fs.writeFileSync(jsonPath, '{}');
    fs.writeFileSync(jsonlPath, '');

    invalidateKiroSessionFiles(sessionId, cwd);

    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  test('rejects an invalid sessionId (path-traversal guard) without touching fs', () => {
    const evil = '../../etc/passwd';
    // Should be a no-op (returns early); create a sentinel to prove nothing else is removed.
    const sentinelDir = path.join(tmpHome, '.kiro', 'sessions', 'cli');
    fs.mkdirSync(sentinelDir, { recursive: true });
    const sentinel = path.join(sentinelDir, 'keep.json');
    fs.writeFileSync(sentinel, 'keep');

    invalidateKiroSessionFiles(evil, cwd);

    expect(fs.existsSync(sentinel)).toBe(true);
  });

  test('missing files → no throw (best-effort)', () => {
    expect(() => invalidateKiroSessionFiles('sess-none', cwd)).not.toThrow();
  });
});
