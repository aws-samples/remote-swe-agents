import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient();
export const ddb = DynamoDBDocumentClient.from(client);

export const TableName = process.env.TABLE_NAME!;
