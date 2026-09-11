import { QueryCommand, PutCommand, DeleteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { ddb, TableName, s3, SkillBucketName, BucketName } from './aws';
import { Skill, MAX_SKILLS_PER_USER, MAX_TOTAL_STORAGE_PER_USER, MAX_SKILL_FILE_COUNT } from '../schema/skill';
import { validateZipEntryPath } from './skill-zip';
import { randomBytes } from 'crypto';
import { parseSkillMd } from './skill-frontmatter';
import { skillS3Prefix } from './skill-s3';

const skillPK = (userId: string) => `skill-${userId}`;

export const getSkill = async (userId: string, skillId: string): Promise<Skill | undefined> => {
  const res = await ddb.send(
    new GetCommand({
      TableName,
      Key: { PK: skillPK(userId), SK: skillId },
    })
  );
  return res.Item as Skill | undefined;
};

export const listSkills = async (userId: string): Promise<Skill[]> => {
  const res = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': skillPK(userId) },
      ScanIndexForward: false,
    })
  );
  return (res.Items as Skill[]) ?? [];
};

export interface CreateSkillInput {
  skillId?: string;
  name: string;
  description: string;
  allowedTools?: string[];
  fileCount: number;
  totalSize: number;
  s3Prefix: string;
}

export const createSkill = async (userId: string, input: CreateSkillInput): Promise<Skill> => {
  const existing = await listSkills(userId);
  if (existing.length >= MAX_SKILLS_PER_USER) {
    throw new Error(`MAX_SKILLS_EXCEEDED: Cannot create more than ${MAX_SKILLS_PER_USER} skills`);
  }

  const now = Date.now();
  const id = input.skillId ?? randomBytes(6).toString('base64url');
  const skill: Skill = {
    PK: skillPK(userId),
    SK: id,
    name: input.name,
    description: input.description,
    allowedTools: input.allowedTools,
    fileCount: input.fileCount,
    totalSize: input.totalSize,
    s3Prefix: input.s3Prefix,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName, Item: skill }));
  return skill;
};

export const updateSkillRecord = async (
  userId: string,
  skillId: string,
  input: Omit<CreateSkillInput, 's3Prefix' | 'skillId'>
): Promise<Skill> => {
  const now = Date.now();
  const result = await ddb.send(
    new UpdateCommand({
      TableName,
      Key: { PK: skillPK(userId), SK: skillId },
      ConditionExpression: 'attribute_exists(PK)',
      UpdateExpression:
        'SET #name = :name, #description = :description, #allowedTools = :allowedTools, #fileCount = :fileCount, #totalSize = :totalSize, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#name': 'name',
        '#description': 'description',
        '#allowedTools': 'allowedTools',
        '#fileCount': 'fileCount',
        '#totalSize': 'totalSize',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':name': input.name,
        ':description': input.description,
        ':allowedTools': input.allowedTools ?? [],
        ':fileCount': input.fileCount,
        ':totalSize': input.totalSize,
        ':updatedAt': now,
      },
      ReturnValues: 'ALL_NEW',
    })
  );
  return result.Attributes as Skill;
};

export const deleteSkillRecord = async (userId: string, skillId: string): Promise<void> => {
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: { PK: skillPK(userId), SK: skillId },
    })
  );
};

export interface SkillFile {
  path: string;
  /** Inline file content. UTF-8 text (string) or raw bytes (Buffer). Mutually exclusive with s3Uri. */
  content?: string | Buffer;
  /** S3 URI (s3://bucket/key) to copy the file content from. Use for binary or large files. */
  s3Uri?: string;
}

export interface RegisterSkillFromFilesInput {
  skillMd: string;
  files?: SkillFile[];
}

export interface UpdateSkillFromFilesInput {
  /**
   * Full content of SKILL.md. Optional only when keepExistingFiles is true,
   * in which case the existing SKILL.md is preserved.
   */
  skillMd?: string;
  files?: SkillFile[];
  /**
   * When true, only the provided files are replaced/added and all other
   * existing files are kept. When false (default), all existing files are
   * replaced by the provided set.
   */
  keepExistingFiles?: boolean;
}

const parseS3Uri = (uri: string): { bucket: string; key: string } => {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.+)$/.exec(uri);
  if (!match) {
    throw new Error(`INVALID_S3_URI: "${uri}" is not a valid S3 URI (expected s3://bucket/key)`);
  }
  return { bucket: match[1], key: match[2] };
};

/**
 * s3Uri sources are restricted to deployment-local buckets to prevent the
 * tool parameter from becoming a generic S3 read primitive:
 * - the session artifact bucket (where agents stage files), any key
 * - the skill bucket, only under the caller's own skills/{userId}/ prefix
 */
const assertAllowedS3Source = (userId: string, bucket: string, key: string): void => {
  if (bucket === BucketName) return;
  if (bucket === SkillBucketName && key.startsWith(`skills/${userId}/`)) return;
  throw new Error(
    `S3_SOURCE_NOT_ALLOWED: s3Uri must reference the session artifact bucket or your own skills/${userId}/ prefix in the skill bucket`
  );
};

const resolveSkillFileBuffer = async (
  userId: string,
  file: SkillFile,
  addToBudget: (bytes: number, path: string) => void
): Promise<Buffer> => {
  const hasContent = file.content !== undefined;
  const hasS3Uri = file.s3Uri !== undefined;
  if (hasContent === hasS3Uri) {
    throw new Error(`INVALID_FILE: File "${file.path}" must specify exactly one of content or s3Uri`);
  }
  if (hasS3Uri) {
    const { bucket, key } = parseS3Uri(file.s3Uri!);
    assertAllowedS3Source(userId, bucket, key);
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (res.ContentLength !== undefined) {
      addToBudget(res.ContentLength, file.path);
    }
    if (!res.Body) {
      throw new Error(`S3_OBJECT_EMPTY: Could not read ${file.s3Uri}`);
    }
    const buffer = Buffer.from(await res.Body.transformToByteArray());
    if (res.ContentLength === undefined) {
      addToBudget(buffer.length, file.path);
    }
    return buffer;
  }
  const buffer = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content as string, 'utf-8');
  addToBudget(buffer.length, file.path);
  return buffer;
};

/**
 * Tracks cumulative resolved bytes and fails fast (before buffering more
 * content in memory) once the total storage limit is exceeded.
 */
const createSizeBudget = () => {
  let total = 0;
  return (bytes: number, path: string) => {
    total += bytes;
    if (total > MAX_TOTAL_STORAGE_PER_USER) {
      throw new Error(`STORAGE_LIMIT_EXCEEDED: Cumulative file size exceeds the storage limit (100 MB) at "${path}"`);
    }
  };
};

const validateSkillFilePaths = (files: SkillFile[] | undefined): void => {
  if (!files) return;
  const seen = new Set<string>();
  for (const f of files) {
    if (!validateZipEntryPath(f.path)) {
      throw new Error(`INVALID_PATH: File path "${f.path}" is not allowed`);
    }
    if (f.path === 'SKILL.md') {
      throw new Error('INVALID_PATH: Use the skillMd parameter to provide SKILL.md');
    }
    if (seen.has(f.path)) {
      throw new Error(`DUPLICATE_PATH: File path "${f.path}" appears more than once`);
    }
    seen.add(f.path);
  }
};

interface S3SkillObject {
  relativePath: string;
  size: number;
}

const listSkillObjects = async (prefix: string): Promise<S3SkillObject[]> => {
  const objects: S3SkillObject[] = [];
  let continuationToken: string | undefined;
  do {
    const listRes = await s3.send(
      new ListObjectsV2Command({ Bucket: SkillBucketName, Prefix: prefix, ContinuationToken: continuationToken })
    );
    for (const obj of listRes.Contents ?? []) {
      if (!obj.Key) continue;
      const relativePath = obj.Key.slice(prefix.length);
      if (!relativePath) continue;
      objects.push({ relativePath, size: obj.Size ?? 0 });
    }
    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
};

export const registerSkillFromFiles = async (userId: string, input: RegisterSkillFromFilesInput): Promise<Skill> => {
  const totalFileCount = 1 + (input.files?.length ?? 0);
  if (totalFileCount > MAX_SKILL_FILE_COUNT) {
    throw new Error(`FILE_COUNT_EXCEEDED: Skill contains ${totalFileCount} files, max is ${MAX_SKILL_FILE_COUNT}`);
  }
  validateSkillFilePaths(input.files);

  const { frontmatter } = parseSkillMd(input.skillMd);
  const addToBudget = createSizeBudget();
  const allFiles: { relativePath: string; content: Buffer }[] = [
    { relativePath: 'SKILL.md', content: Buffer.from(input.skillMd, 'utf-8') },
  ];
  addToBudget(allFiles[0].content.length, 'SKILL.md');
  if (input.files) {
    for (const f of input.files) {
      allFiles.push({ relativePath: f.path, content: await resolveSkillFileBuffer(userId, f, addToBudget) });
    }
  }

  const totalSize = allFiles.reduce((sum, f) => sum + f.content.length, 0);

  const existing = await listSkills(userId);
  if (existing.length >= MAX_SKILLS_PER_USER) {
    throw new Error(`MAX_SKILLS_EXCEEDED: Cannot create more than ${MAX_SKILLS_PER_USER} skills`);
  }
  const totalUsed = existing.reduce((sum, s) => sum + s.totalSize, 0);
  if (totalUsed + totalSize > MAX_TOTAL_STORAGE_PER_USER) {
    throw new Error('STORAGE_LIMIT_EXCEEDED: Total storage limit exceeded (100 MB).');
  }

  const skillId = randomBytes(6).toString('base64url');
  const prefix = skillS3Prefix(userId, skillId);

  for (const file of allFiles) {
    await s3.send(
      new PutObjectCommand({ Bucket: SkillBucketName, Key: `${prefix}/${file.relativePath}`, Body: file.content })
    );
  }

  return createSkill(userId, {
    skillId,
    name: frontmatter.name,
    description: frontmatter.description,
    allowedTools: frontmatter.allowedTools,
    fileCount: allFiles.length,
    totalSize,
    s3Prefix: prefix,
  });
};

export const updateSkillFromFiles = async (
  userId: string,
  skillId: string,
  input: UpdateSkillFromFilesInput
): Promise<Skill> => {
  const keepExistingFiles = input.keepExistingFiles ?? false;
  if (input.skillMd === undefined && !keepExistingFiles) {
    throw new Error('SKILL_MD_REQUIRED: skillMd is required unless keepExistingFiles is true');
  }
  if (input.skillMd === undefined && (input.files?.length ?? 0) === 0) {
    throw new Error('NO_CHANGES: Provide skillMd and/or files to update');
  }
  const providedFileCount = (input.skillMd !== undefined ? 1 : 0) + (input.files?.length ?? 0);
  if (providedFileCount > MAX_SKILL_FILE_COUNT) {
    throw new Error(`FILE_COUNT_EXCEEDED: Skill contains ${providedFileCount} files, max is ${MAX_SKILL_FILE_COUNT}`);
  }
  validateSkillFilePaths(input.files);

  const existing = await getSkill(userId, skillId);
  if (!existing) {
    throw new Error('SKILL_NOT_FOUND: Skill does not exist.');
  }

  const prefix = existing.s3Prefix.endsWith('/') ? existing.s3Prefix : `${existing.s3Prefix}/`;

  const addToBudget = createSizeBudget();
  const uploadFiles: { relativePath: string; content: Buffer }[] = [];
  if (input.skillMd !== undefined) {
    const content = Buffer.from(input.skillMd, 'utf-8');
    addToBudget(content.length, 'SKILL.md');
    uploadFiles.push({ relativePath: 'SKILL.md', content });
  }
  if (input.files) {
    for (const f of input.files) {
      uploadFiles.push({ relativePath: f.path, content: await resolveSkillFileBuffer(userId, f, addToBudget) });
    }
  }

  // Resolve frontmatter from the new SKILL.md, or from the existing one when unchanged
  let skillMdContent = input.skillMd;
  if (skillMdContent === undefined) {
    let res;
    try {
      res = await s3.send(new GetObjectCommand({ Bucket: SkillBucketName, Key: `${prefix}SKILL.md` }));
    } catch (e) {
      throw new Error(
        `SKILL_MD_MISSING: Existing SKILL.md could not be read from S3 (${(e as Error).name}). Provide skillMd explicitly to repair the skill.`
      );
    }
    if (!res.Body) {
      throw new Error('SKILL_MD_MISSING: Existing SKILL.md could not be read from S3');
    }
    skillMdContent = Buffer.from(await res.Body.transformToByteArray()).toString('utf-8');
  }
  const { frontmatter } = parseSkillMd(skillMdContent);

  // Compute the final file set from the actual S3 state so that
  // fileCount/totalSize always reflect reality (heals metadata drift).
  const existingObjects = await listSkillObjects(prefix);
  const uploadPaths = new Set(uploadFiles.map((f) => f.relativePath));
  const keptObjects = keepExistingFiles ? existingObjects.filter((o) => !uploadPaths.has(o.relativePath)) : [];

  const fileCount = uploadFiles.length + keptObjects.length;
  if (fileCount > MAX_SKILL_FILE_COUNT) {
    throw new Error(`FILE_COUNT_EXCEEDED: Skill contains ${fileCount} files, max is ${MAX_SKILL_FILE_COUNT}`);
  }
  const totalSize =
    uploadFiles.reduce((sum, f) => sum + f.content.length, 0) + keptObjects.reduce((sum, o) => sum + o.size, 0);

  const allSkills = await listSkills(userId);
  const totalUsed = allSkills.reduce((sum, s) => sum + s.totalSize, 0) - existing.totalSize;
  if (totalUsed + totalSize > MAX_TOTAL_STORAGE_PER_USER) {
    throw new Error('STORAGE_LIMIT_EXCEEDED: Total storage limit exceeded (100 MB).');
  }

  if (!keepExistingFiles) {
    // Delete old files not in the new set
    const toDelete = existingObjects
      .filter((o) => !uploadPaths.has(o.relativePath))
      .map((o) => ({ Key: `${prefix}${o.relativePath}` }));
    for (let i = 0; i < toDelete.length; i += 1000) {
      await s3.send(
        new DeleteObjectsCommand({ Bucket: SkillBucketName, Delete: { Objects: toDelete.slice(i, i + 1000) } })
      );
    }
  }

  for (const file of uploadFiles) {
    await s3.send(
      new PutObjectCommand({ Bucket: SkillBucketName, Key: `${prefix}${file.relativePath}`, Body: file.content })
    );
  }

  return updateSkillRecord(userId, skillId, {
    name: frontmatter.name,
    description: frontmatter.description,
    allowedTools: frontmatter.allowedTools,
    fileCount,
    totalSize,
  });
};
