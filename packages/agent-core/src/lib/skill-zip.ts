import * as yauzl from 'yauzl-promise';
import { Readable } from 'stream';
import { isAbsolute, normalize } from 'node:path';
import { MAX_SKILL_FILE_COUNT, ZIP_BOMB_THRESHOLD } from '../schema/skill';

export interface ExtractedFile {
  relativePath: string;
  content: Buffer;
}

export interface ExtractResult {
  files: ExtractedFile[];
  totalSize: number;
}

const streamToBuffer = (stream: Readable, maxBytes: number): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        reject(new Error(`Extracted content exceeds safety limit of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
};

export const validateZipEntryPath = (entryName: string): boolean => {
  if (!entryName || entryName.includes('\0')) return false;
  if (isAbsolute(entryName)) return false;
  const rawParts = entryName.split(/[/\\]/);
  if (rawParts.some((p: string) => p === '..')) return false;
  const normalized = normalize(entryName);
  if (normalized.startsWith('..')) return false;
  const parts = normalized.split(/[/\\]/);
  const basename = parts.at(-1);
  if (basename && basename.startsWith('.') && basename !== '.gitkeep') return false;
  return true;
};

export const extractZipBuffer = async (zipBuffer: Buffer): Promise<ExtractResult> => {
  const zipFile = await yauzl.fromBuffer(zipBuffer, { decodeStrings: true, validateEntrySizes: true });
  const files: ExtractedFile[] = [];
  let totalSize = 0;
  let singleTopDir: string | null | undefined = undefined;

  try {
    const entries = await zipFile.readEntries(zipFile.entryCount);

    const topLevelNames = new Set<string>();
    for (const entry of entries) {
      const firstPart = entry.filename.split('/')[0];
      if (firstPart) topLevelNames.add(firstPart);
    }
    if (topLevelNames.size === 1) {
      const onlyDir = [...topLevelNames][0]!;
      const allUnderDir = entries.every((e) => e.filename.startsWith(onlyDir + '/') || e.filename === onlyDir + '/');
      if (allUnderDir) singleTopDir = onlyDir;
    }

    for (const entry of entries) {
      if (entry.filename.endsWith('/')) continue;

      if (entry.uncompressedSize > ZIP_BOMB_THRESHOLD) {
        throw new Error(`Entry ${entry.filename} declared size exceeds safety limit`);
      }

      let relativePath = entry.filename;
      if (singleTopDir) {
        relativePath = relativePath.slice(singleTopDir.length + 1);
        if (!relativePath) continue;
      }

      if (!validateZipEntryPath(relativePath)) {
        throw new Error(`Invalid path in zip: ${entry.filename}`);
      }

      if (files.length >= MAX_SKILL_FILE_COUNT) {
        throw new Error(`Zip contains more than ${MAX_SKILL_FILE_COUNT} files`);
      }

      const stream = await zipFile.openReadStream(entry);
      const content = await streamToBuffer(stream, ZIP_BOMB_THRESHOLD);

      totalSize += content.length;
      if (totalSize > ZIP_BOMB_THRESHOLD) {
        throw new Error(`Cumulative extracted size exceeds safety limit of ${ZIP_BOMB_THRESHOLD} bytes`);
      }

      files.push({ relativePath, content });
    }
  } finally {
    await zipFile.close();
  }

  const hasSkillMd = files.some((f) => f.relativePath === 'SKILL.md');
  if (!hasSkillMd) {
    throw new Error('Zip must contain a SKILL.md file at the root or in a single top-level directory');
  }

  return { files, totalSize };
};
