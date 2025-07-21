import { z } from 'zod';
import { Tool, ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { promises as fs } from 'fs';
import sharp from 'sharp';

const inputSchema = z.object({
  imagePath: z.string().describe('The local file system path (absolute) to the image.'),
});

const name = 'readLocalImage';

export const readImageTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>) => {
    // Check if file exists
    await fs.access(input.imagePath);

    // Convert image to webp format using sharp
    const webpBuffer = await sharp(input.imagePath).webp().toBuffer();

    // Return JSON stringified result with image data
    return [
      {
        image: {
          format: 'webp',
          source: { bytes: webpBuffer },
        },
      },
    ];
  },
  schema: inputSchema,
  toolSpec: async (): Promise<NonNullable<Tool['toolSpec']>> => {
    return {
    name,
    description: `Read an image in the local file system. Use this tool to get the visual details of an image. You cannot pass an Internet URL here; you must download the image locally first.`,
    inputSchema: {
        json: zodToJsonSchemaBody(inputSchema),
      } as ToolInputSchema,
  };
  },
};
