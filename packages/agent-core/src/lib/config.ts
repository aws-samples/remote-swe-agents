import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CONFIG_TABLE_NAME, MODEL_CONFIG_KEY } from '../schema/config';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

export const getModelConfig = async (): Promise<string | undefined> => {
  const tableName = process.env.CONFIG_TABLE_NAME || CONFIG_TABLE_NAME;

  try {
    const command = new GetCommand({
      TableName: tableName,
      Key: {
        PK: MODEL_CONFIG_KEY,
        SK: MODEL_CONFIG_KEY,
      },
    });

    const response = await docClient.send(command);
    return response.Item?.value;
  } catch (error) {
    console.error('Error getting model config:', error);
    return undefined;
  }
};

export const setModelConfig = async (modelId: string): Promise<void> => {
  const tableName = process.env.CONFIG_TABLE_NAME || CONFIG_TABLE_NAME;

  try {
    const command = new PutCommand({
      TableName: tableName,
      Item: {
        PK: MODEL_CONFIG_KEY,
        SK: MODEL_CONFIG_KEY,
        value: modelId,
      },
    });

    await docClient.send(command);
  } catch (error) {
    console.error('Error setting model config:', error);
    throw error;
  }
};
