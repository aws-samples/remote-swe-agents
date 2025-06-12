'use server';

import { authActionClient } from '@/lib/safe-action';
import { z } from 'zod';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// Schema for prompt saving
export const savePromptSchema = z.object({
  additionalSystemPrompt: z.string().optional(),
});

// Schema for prompt retrieval - empty because we don't need any input
export const getPromptSchema = z.object({});

// DynamoDB configuration
const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TableName = process.env.TABLE_NAME!;

// Create actions using the safe-action client
export const savePromptAction = authActionClient
  .schema(savePromptSchema)
  .action(async ({ parsedInput: { additionalSystemPrompt } }) => {
    try {
      await ddb.send(
        new PutCommand({
          TableName,
          Item: {
            PK: 'global-config',
            SK: 'prompt',
            additionalSystemPrompt: additionalSystemPrompt || '',
          },
        })
      );

      return { success: true };
    } catch (error) {
      console.error('Error saving prompt to DynamoDB:', error);
      throw new Error('Failed to save prompt configuration');
    }
  });

export const getPromptAction = authActionClient.schema(getPromptSchema).action(async () => {
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName,
        Key: {
          PK: 'global-config',
          SK: 'prompt',
        },
      })
    );

    if (!result.Item) {
      // If no item exists, return default empty prompt
      return { additionalSystemPrompt: '' };
    }

    return {
      additionalSystemPrompt: result.Item.additionalSystemPrompt || '',
    };
  } catch (error) {
    console.error('Error reading prompt from DynamoDB:', error);
    throw new Error('Failed to load prompt configuration');
  }
});
