import { BatchWriteCommand, BatchWriteCommandOutput } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './ddb';

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 100;

export async function batchWriteWithRetry(
  items: { DeleteRequest?: { Key: Record<string, any> }; PutRequest?: { Item: Record<string, any> } }[]
): Promise<void> {
  let unprocessed: typeof items = items;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (unprocessed.length === 0) return;

    const result: BatchWriteCommandOutput = await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [TableName]: unprocessed,
        },
      })
    );

    const remaining = result.UnprocessedItems?.[TableName];
    if (!remaining || remaining.length === 0) return;

    unprocessed = remaining as typeof items;

    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 50;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`BatchWrite failed after ${MAX_RETRIES + 1} attempts with ${unprocessed.length} unprocessed items`);
}
