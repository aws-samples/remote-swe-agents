import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { sendAgentMessage } from '../../lib/agent-messaging';
import { getSession } from '../../lib/sessions';
import { s3, BucketName } from '../../lib/aws/s3';
import { S3Client, PutObjectCommand, GetObjectCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { readFileSync, statSync, writeFileSync } from 'fs';
import { extname, basename } from 'path';
import { buildAttachmentSentinel, getAttachedFileKey } from '../../lib';
import { sendFileToSlack } from '../../lib/slack';

const inputSchema = z.object({
  filePath: z.string().describe('the local file system path to the file, or an S3 URI (s3://bucket/key)'),
  message: z.string().describe('message to send along with the file'),
  targetSessionId: z
    .string()
    .optional()
    .describe('Target session ID to send the file to. Defaults to parent session if omitted.'),
});

const name = 'sendFileToAgent';

export const sendFileToAgentTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const session = await getSession(context.workerId);
    const targetSessionId = input.targetSessionId || session?.parentSessionId;

    if (!targetSessionId) {
      return 'Error: No targetSessionId provided and this session has no parent session.';
    }

    let fileBuffer: Buffer;
    let fileName: string;
    let fileSize: number;

    if (input.filePath.startsWith('s3://')) {
      const match = input.filePath.match(/^s3:\/\/([^/]+)\/(.+)$/);
      if (!match) {
        return `Error: Invalid S3 URI: ${input.filePath}`;
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
    } else {
      try {
        fileBuffer = readFileSync(input.filePath);
        fileName = basename(input.filePath);
        fileSize = statSync(input.filePath).size;
      } catch (e: any) {
        return `Error reading file: ${e.message}`;
      }
    }

    const ext = extname(fileName).toLowerCase();
    const contentType = getContentType(ext);
    const s3Key = getAttachedFileKey(context.workerId, context.toolUseId, fileName);

    await s3.send(
      new PutObjectCommand({
        Bucket: BucketName,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: contentType,
      })
    );

    const s3Uri = `s3://${BucketName}/${s3Key}`;
    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'].includes(ext);

    const targetSession = await getSession(targetSessionId);
    if (targetSession?.agentStatus === 'completed') {
      const localPath = `/tmp/${fileName}`;
      writeFileSync(localPath, fileBuffer);
      await sendFileToSlack(localPath, input.message);
      const sentinel = buildAttachmentSentinel({ key: s3Key, isImage });
      return (
        `Target session ${targetSessionId} is completed. File delivered directly to user as fallback.\n` +
        `successfully sent a ${isImage ? 'image' : 'file'} (${fileName}, ${fileSize} bytes) with message.\n${sentinel}`
      );
    }

    const agentMessage = `[File sent via sendFileToAgent]\nFile: ${s3Uri} (${fileName}, ${fileSize} bytes)\nMessage: ${input.message}`;

    const result = await sendAgentMessage({
      senderWorkerId: context.workerId,
      targetSessionIds: [targetSessionId],
      message: agentMessage,
    });

    if (result.failed.length > 0) {
      return (
        `Error sending file to agent: ${result.failed[0].reason}\n` +
        `The file was uploaded to S3 and is available at: ${s3Uri}\n` +
        `You may retry or use sendFileToUser to deliver directly.`
      );
    }

    return `Successfully sent file (${fileName}, ${fileSize} bytes) to session ${targetSessionId}.`;
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Send a file to another agent session. Uploads the file to S3 and sends the S3 URI with a message to the target agent.
If targetSessionId is omitted, the file is sent to the parent session.

Use this tool to share files (screenshots, logs, artifacts, etc.) with your parent or sibling sessions.
The receiving agent can then use sendFileToUser to deliver the file to the user if appropriate.

The filePath parameter accepts:
- Local file path: /tmp/output.png
- S3 URI: s3://bucket-name/path/to/file.png`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};

function getContentType(ext: string): string {
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
}
