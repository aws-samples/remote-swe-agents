'use server';

import { authActionClient } from '@/lib/safe-action';
import { GetObjectCommand, HeadObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BucketName, s3 } from '@remote-swe-agents/agent-core/aws';
import { z } from 'zod';

const getImageUrlsSchema = z.object({
  keys: z.array(z.string()),
});

export const getImageUrls = authActionClient.inputSchema(getImageUrlsSchema).action(async ({ parsedInput }) => {
  const { keys } = parsedInput;
  if (!BucketName) {
    throw new Error('S3 bucket name is not configured');
  }

  const results = (
    await Promise.all(
      keys.map(async (key) => {
        try {
          await s3.send(
            new HeadObjectCommand({
              Bucket: BucketName,
              Key: key,
            })
          );
        } catch (e) {
          if (e instanceof NoSuchKey) {
            return;
          }
          throw e;
        }

        const command = new GetObjectCommand({
          Bucket: BucketName,
          Key: key,
        });

        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

        return {
          url: signedUrl,
          key,
        };
      })
    )
  ).filter((r) => r != null);

  return results;
});
