'use server';

import { authActionClient } from '@/lib/safe-action';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomBytes } from 'crypto';
import { z } from 'zod';

const s3 = new S3Client({});

const bucketName = process.env.BUCKET_NAME;

const imageContentTypes = ['image/png', 'image/webp', 'image/jpeg'];

const getUploadUrlSchema = z.object({
  workerId: z.string().optional(),
  contentType: z.string(),
  fileName: z.string().optional(),
});

export const getUploadUrl = authActionClient.inputSchema(getUploadUrlSchema).action(async ({ parsedInput }) => {
  const { workerId, contentType, fileName } = parsedInput;
  if (!bucketName) {
    throw new Error('S3 bucket name is not configured');
  }

  const isImage = imageContentTypes.includes(contentType);
  const randomId = randomBytes(8).toString('hex');

  // Sanitize filename: replace spaces and special chars with underscores
  const sanitizeFileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '_');

  let key: string;
  if (isImage) {
    const extension = contentType.split('/')[1];
    key = workerId ? `${workerId}/${randomId}.${extension}` : `webapp_init/${randomId}.${extension}`;
  } else {
    const safeName = sanitizeFileName(fileName || `file-${randomId}`);
    key = workerId ? `${workerId}/${randomId}/${safeName}` : `webapp_init/${randomId}/${safeName}`;
  }

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
  });

  const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

  return {
    url: signedUrl,
    key,
    isImage,
  };
});
