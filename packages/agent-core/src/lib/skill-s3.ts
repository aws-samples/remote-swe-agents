import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { s3, SkillBucketName } from './aws';

export const skillS3Prefix = (userId: string, skillId: string) => `skills/${userId}/${skillId}`;

export const deleteSkillFiles = async (s3Prefix: string): Promise<void> => {
  const prefix = s3Prefix.endsWith('/') ? s3Prefix : `${s3Prefix}/`;
  let continuationToken: string | undefined;

  do {
    const listRes = await s3.send(
      new ListObjectsV2Command({
        Bucket: SkillBucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const objects = listRes.Contents;
    if (objects && objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: SkillBucketName,
          Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
        })
      );
    }
    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);
};
