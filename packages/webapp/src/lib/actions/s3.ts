'use server';

import { authActionClient } from '@/lib/safe-action';
import { z } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// S3クライアントの作成
const s3 = new S3Client({});

// バケット名を環境変数から取得
const bucketName = process.env.BUCKET_NAME;

if (!bucketName) {
  console.error('BUCKET_NAME environment variable is not set');
}

// アップロード用のpresigned URLを取得するためのスキーマ
const getUploadUrlSchema = z.object({
  fileName: z.string(),
  contentType: z.string(),
});

// 戻り値の型定義
type UploadUrlResult = {
  url: string;
  key: string;
};

// S3アップロード用のpresigned URLを取得するサーバーアクション
export const getUploadUrl = authActionClient
  .schema(getUploadUrlSchema)
  .action(async ({ parsedInput: { fileName, contentType } }) => {
    if (!bucketName) {
      throw new Error('S3 bucket name is not configured');
    }

    // ファイル名に日時を追加して一意にする
    const timestamp = Date.now();
    const key = `uploads/${timestamp}-${fileName}`;

    try {
      // PutObjectコマンドの作成
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: contentType,
      });

      // Presigned URLを取得
      const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1時間有効

      return {
        url: signedUrl,
        key,
      } satisfies UploadUrlResult;
    } catch (error) {
      console.error('Error generating presigned URL:', error);
      throw new Error('Failed to generate upload URL');
    }
  });

// ファイルアップロード完了を記録するスキーマ
const completeUploadSchema = z.object({
  key: z.string(),
});

// アップロード完了を記録するサーバーアクション
export const completeUpload = authActionClient.schema(completeUploadSchema).action(async ({ parsedInput: { key } }) => {
  // アップロードが完了したファイルのキーを返す
  return {
    key,
  };
});
