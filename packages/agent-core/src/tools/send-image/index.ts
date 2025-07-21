import { z } from 'zod';
import { Tool, ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { sendFileToSlack } from '../../lib/slack';
import { s3, BucketName } from '../../lib/aws/s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import { extname } from 'path';
import { WorkerId } from '../../env';
import { getAttachedImageKey } from '../../lib';

const inputSchema = z.object({
  imagePath: z.string().describe('the local file system path to the image'),
  message: z.string().describe('message to send along with the image to user'),
});

const name = 'sendImageToUser';

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
    default:
      return 'image/jpeg';
  }
};

export const sendImageTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context: { toolUseId: string }) => {
    await sendFileToSlack(input.imagePath, input.message);

    const fileBuffer = readFileSync(input.imagePath);
    const contentType = getContentTypeFromExtension(input.imagePath);
    const s3Key = getAttachedImageKey(WorkerId, context.toolUseId, input.imagePath);

    await s3.send(
      new PutObjectCommand({
        Bucket: BucketName,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: contentType,
      })
    );

    return 'successfully sent an image with message.';
  },
  schema: inputSchema,
  toolSpec: async (): Promise<NonNullable<Tool['toolSpec']>> => {
    return {
    name,
    description: `Send an image with a message to the user. This tool will upload an image from a local file path and send it to the user through Slack and/or WebUI with an accompanying message.`,
    inputSchema: {
        json: zodToJsonSchemaBody(inputSchema),
      } as ToolInputSchema,
  };
  },
};
