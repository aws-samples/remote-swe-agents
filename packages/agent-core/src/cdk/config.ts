import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { CONFIG_TABLE_NAME } from '../schema/config';

export async function createConfigTable() {
  const client = new DynamoDBClient({});

  try {
    const command = new CreateTableCommand({
      TableName: CONFIG_TABLE_NAME,
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });

    await client.send(command);
    console.log(`Config table created: ${CONFIG_TABLE_NAME}`);
    return true;
  } catch (error) {
    if ((error as any)?.name === 'ResourceInUseException') {
      console.log(`Config table already exists: ${CONFIG_TABLE_NAME}`);
      return true;
    }
    console.error('Error creating config table:', error);
    return false;
  }
}
