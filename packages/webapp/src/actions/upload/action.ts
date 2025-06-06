'use server';

import { authActionClient } from '@/lib/safe-action';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomBytes } from 'crypto';
import { z } from 'zod';

const s3 = new S3Client({});

const bucketName = process.env.BUCKET_NAME;

const getUploadUrlSchema = z.object({
  workerId: z.string().optional(),
  contentType: z.string(),
});

export const getUploadUrl = authActionClient
  .schema(getUploadUrlSchema)
  .action(async ({ parsedInput: { workerId, contentType } }) => {
    if (!bucketName) {
      throw new Error('S3 bucket name is not configured');
    }
    if (!['image/png', 'image/webp', 'image/jpeg'].includes(contentType)) {
      throw new Error('Invalid content type');
    }

    const extension = contentType.split('/')[1];
    const randomId = randomBytes(8).toString('hex');

    // If workerId is provided, use it in the path, otherwise use webapp_init prefix
    const key = workerId ? `${workerId}/${randomId}.${extension}` : `webapp_init/${randomId}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: contentType,
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

    return {
      url: signedUrl,
      key,
    };
  });
