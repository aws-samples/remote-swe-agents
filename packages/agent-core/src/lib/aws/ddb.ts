import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const TableName = process.env.TABLE_NAME!;

// Allow configuration of DynamoDB endpoint via environment variable
// This enables using DynamoDB Local for development
const clientConfig: {
  endpoint?: string;
} = {};

if (process.env.DYNAMODB_ENDPOINT) {
  clientConfig.endpoint = process.env.DYNAMODB_ENDPOINT;
  console.log(`Using custom DynamoDB endpoint: ${process.env.DYNAMODB_ENDPOINT}`);
}

const client = new DynamoDBClient(clientConfig);
export const ddb = DynamoDBDocumentClient.from(client);
