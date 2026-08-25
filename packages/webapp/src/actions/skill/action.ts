'use server';

import { authActionClient, MyCustomError } from '@/lib/safe-action';
import {
  listSkills as listSkillsDb,
  getSkill,
  deleteSkillRecord,
  deleteSkillFiles,
  registerSkillFromFiles,
} from '@remote-swe-agents/agent-core/lib';
import { SkillBucketName } from '@remote-swe-agents/agent-core/aws';
import { MAX_TOTAL_STORAGE_PER_USER } from '@remote-swe-agents/agent-core/schema';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

const s3 = new S3Client({});

const getSkillUploadUrlSchema = z.object({
  fileName: z.string(),
  contentType: z.string(),
});

export const getSkillUploadUrl = authActionClient
  .inputSchema(getSkillUploadUrlSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { fileName, contentType } = parsedInput;

    const allSkills = await listSkillsDb(ctx.userId);
    const totalUsed = allSkills.reduce((sum, s) => sum + s.totalSize, 0);
    if (totalUsed >= MAX_TOTAL_STORAGE_PER_USER) {
      throw new MyCustomError('Total storage limit exceeded (100 MB). Delete unused skills to free space.');
    }

    const key = `skills/${ctx.userId}/_uploads/${Date.now()}-${fileName}`;
    const command = new PutObjectCommand({
      Bucket: SkillBucketName,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 300 });

    return { url, key };
  });

const registerSkillSchema = z.object({
  s3Key: z.string(),
});

export const registerSkill = authActionClient.inputSchema(registerSkillSchema).action(async ({ parsedInput, ctx }) => {
  const expectedPrefix = `skills/${ctx.userId}/`;
  if (!parsedInput.s3Key.startsWith(expectedPrefix)) {
    throw new MyCustomError('Invalid upload path.');
  }

  const zipRes = await s3.send(new GetObjectCommand({ Bucket: SkillBucketName, Key: parsedInput.s3Key }));
  const zipBuffer = Buffer.from(await zipRes.Body!.transformToByteArray());

  const { extractZipBuffer } = await import('@remote-swe-agents/agent-core/lib');

  let files, totalSize;
  try {
    ({ files, totalSize } = await extractZipBuffer(zipBuffer));
  } catch (e) {
    throw new MyCustomError((e as Error).message);
  }

  const skillMdFile = files.find((f) => f.relativePath === 'SKILL.md');
  if (!skillMdFile) {
    throw new MyCustomError('Package must contain a SKILL.md file at the root.');
  }

  const skillMd = skillMdFile.content.toString('utf-8');
  const supportingFiles = files
    .filter((f) => f.relativePath !== 'SKILL.md')
    .map((f) => ({ path: f.relativePath, content: f.content }));

  let skill;
  try {
    skill = await registerSkillFromFiles(ctx.userId, {
      skillMd,
      files: supportingFiles.length > 0 ? supportingFiles : undefined,
    });
  } catch (e) {
    throw new MyCustomError((e as Error).message);
  }

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: SkillBucketName, Key: parsedInput.s3Key }));
  } catch (e) {
    console.warn('[skill] temp zip cleanup failed:', e);
  }

  return skill;
});

export const listUserSkills = authActionClient.action(async ({ ctx }) => {
  return listSkillsDb(ctx.userId);
});

const deleteSkillSchema = z.object({
  skillId: z.string(),
});

export const deleteSkill = authActionClient.inputSchema(deleteSkillSchema).action(async ({ parsedInput, ctx }) => {
  const skill = await getSkill(ctx.userId, parsedInput.skillId);
  if (!skill) {
    throw new MyCustomError('Skill not found.');
  }
  await deleteSkillRecord(ctx.userId, parsedInput.skillId);
  try {
    await deleteSkillFiles(skill.s3Prefix);
  } catch (error) {
    console.error('[deleteSkill] S3 cleanup failed (best-effort):', error);
  }
  return { success: true };
});
