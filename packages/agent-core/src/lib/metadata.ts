import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws/ddb';

/**
 * Write metadata to DynamoDB.
 * @param tag The tag to use as the SK in DynamoDB
 * @param data The object data to store
 * @param workerId The worker ID to use as part of the PK
 */
export const writeMetadata = async (tag: string, data: object, workerId: string = process.env.WORKER_ID!) => {
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: `metadata-${workerId}`,
        SK: tag,
        ...data,
      },
    })
  );
};

/**
 * Read metadata from DynamoDB.
 * @param tag The tag to use as the SK in DynamoDB
 * @param workerId The worker ID to use as part of the PK
 * @returns The metadata object (without DynamoDB key attributes) or undefined if not found
 */
export const readMetadata = async (tag: string, workerId: string = process.env.WORKER_ID!) => {
  const result = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: `metadata-${workerId}`,
        SK: tag,
      },
    })
  );

  if (!result.Item) return undefined;

  // Strip DynamoDB key attributes so callers see only the domain payload.
  // Without this, callers would need to cast the record to account for the
  // stray `PK` / `SK` fields on every read.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { PK, SK, ...data } = result.Item as { PK?: string; SK?: string } & Record<string, unknown>;
  return data;
};
