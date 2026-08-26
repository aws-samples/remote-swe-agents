import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { sendFileToSlack } from '../../lib/slack';
import { s3, BucketName } from '../../lib/aws/s3';
import { S3Client, PutObjectCommand, GetObjectCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { readFileSync, statSync, writeFileSync } from 'fs';
import { extname, basename } from 'path';
import { buildAttachmentSentinel, getAttachedFileKey } from '../../lib';
import { withChildSessionGuard } from '../child-guard';

const inputSchema = z.object({
  filePath: z.string().describe('the local file system path to the file, or an S3 URI (s3://bucket/key)'),
  message: z.string().describe('message to send along with the file to user'),
});

const name = 'sendFileToUser';

const getContentTypeFromExtension = (filePath: string): string => {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.gif':
      return 'image/gif';
    case '.pdf':
      return 'application/pdf';
    case '.zip':
      return 'application/zip';
    case '.gz':
    case '.tgz':
      return 'application/gzip';
    case '.tar':
      return 'application/x-tar';
    case '.json':
      return 'application/json';
    case '.xml':
      return 'application/xml';
    case '.csv':
      return 'text/csv';
    case '.txt':
    case '.log':
    case '.md':
      return 'text/plain';
    case '.html':
    case '.htm':
      return 'text/html';
    default:
      return 'application/octet-stream';
  }
};

const isImageFile = (filePath: string): boolean => {
  const ext = extname(filePath).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'].includes(ext);
};

export const sendFileToUser = async (
  filePath: string,
  message: string,
  context: { workerId: string; toolUseId: string }
): Promise<string> => {
  let localPath = filePath;
  let fileBuffer: Buffer;
  let fileName: string;
  let fileSize: number;

  if (filePath.startsWith('s3://')) {
    const match = filePath.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      return `Error: Invalid S3 URI: ${filePath}`;
    }
    const [, srcBucket, srcKey] = match;
    fileName = basename(srcKey);

    try {
      let srcS3 = s3;
      if (srcBucket !== BucketName) {
        const locationResp = await s3.send(new GetBucketLocationCommand({ Bucket: srcBucket }));
        const bucketRegion = locationResp.LocationConstraint || 'us-east-1';
        srcS3 = new S3Client({ region: bucketRegion });
      }

      const obj = await srcS3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
      const bytes = await obj.Body!.transformToByteArray();
      fileBuffer = Buffer.from(bytes);
      fileSize = fileBuffer.length;
    } catch (e: any) {
      return `Error downloading from S3: ${e.name}: ${e.message}`;
    }

    localPath = `/tmp/${fileName}`;
    writeFileSync(localPath, fileBuffer);
  } else {
    fileBuffer = readFileSync(filePath);
    fileName = basename(filePath);
    fileSize = statSync(filePath).size;
  }

  await sendFileToSlack(localPath, message);

  const contentType = getContentTypeFromExtension(fileName);
  const s3Key = getAttachedFileKey(context.workerId, context.toolUseId, fileName);
  const isImage = isImageFile(fileName);

  await s3.send(
    new PutObjectCommand({
      Bucket: BucketName,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: contentType,
      ContentDisposition: isImage ? undefined : `attachment; filename="${fileName}"`,
    })
  );

  const sentinel = buildAttachmentSentinel({ key: s3Key, isImage });
  return `successfully sent a ${isImage ? 'image' : 'file'} (${fileName}, ${fileSize} bytes) with message.\n${sentinel}`;
};

const coreSendFileHandler = async (
  input: z.infer<typeof inputSchema>,
  context: { workerId: string; toolUseId: string; globalPreferences: any; cancellationToken?: any }
): Promise<string> => {
  return sendFileToUser(input.filePath, input.message, context);
};

const guardedSendFileHandler = withChildSessionGuard(coreSendFileHandler, {
  pendingKey: 'user-file',
  confirmToolName: 'confirmSendFileToUser',
  serializePending: (input) => JSON.stringify(input),
  toolDisplayName: 'sendFileToUser',
});

export const sendFileTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: guardedSendFileHandler,
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Send a file with a message to the user. This tool will upload a file from a local file path or S3 URI and send it to the user through Slack and/or WebUI with an accompanying message. Supports any file type including images, documents, archives, etc. For images, a preview will be shown in the chat. For other files, a download link will be provided.

The filePath parameter accepts:
- Local file path: /tmp/output.png
- S3 URI: s3://bucket-name/path/to/file.png`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
