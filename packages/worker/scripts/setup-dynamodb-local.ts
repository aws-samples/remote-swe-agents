/**
 * This script sets up the necessary DynamoDB local table for development.
 * Run this script after starting DynamoDB Local with docker-compose.
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
  ScalarAttributeType,
  KeyType,
  ProjectionType,
  BillingMode,
} from '@aws-sdk/client-dynamodb';

// Configuration
const ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
const TABLE_NAME = process.env.TABLE_NAME || 'RemoteSWEAgentsTable-local';
const REGION = process.env.AWS_REGION || 'ap-northeast-1';

// Initialize DynamoDB Client
const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: REGION,
});

// Table definition based on the actual schema used in the app
const tableParams = {
  TableName: TABLE_NAME,
  AttributeDefinitions: [
    {
      AttributeName: 'pk',
      AttributeType: ScalarAttributeType.S,
    },
    {
      AttributeName: 'sk',
      AttributeType: ScalarAttributeType.S,
    },
    {
      AttributeName: 'gsi1pk',
      AttributeType: ScalarAttributeType.S,
    },
    {
      AttributeName: 'gsi1sk',
      AttributeType: ScalarAttributeType.S,
    },
  ],
  KeySchema: [
    {
      AttributeName: 'pk',
      KeyType: KeyType.HASH,
    },
    {
      AttributeName: 'sk',
      KeyType: KeyType.RANGE,
    },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi1',
      KeySchema: [
        {
          AttributeName: 'gsi1pk',
          KeyType: KeyType.HASH,
        },
        {
          AttributeName: 'gsi1sk',
          KeyType: KeyType.RANGE,
        },
      ],
      Projection: {
        ProjectionType: ProjectionType.ALL,
      },
      ProvisionedThroughput: {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5,
      },
    },
  ],
  BillingMode: BillingMode.PROVISIONED,
  ProvisionedThroughput: {
    ReadCapacityUnits: 5,
    WriteCapacityUnits: 5,
  },
};

async function checkTableExists(tableName: string): Promise<boolean> {
  try {
    const { TableNames } = await client.send(new ListTablesCommand({}));
    return TableNames!.includes(tableName);
  } catch (error) {
    console.error('Error checking if table exists:', error);
    return false;
  }
}

async function createTable(): Promise<void> {
  try {
    // Check if table already exists
    const tableExists = await checkTableExists(TABLE_NAME);

    if (tableExists) {
      console.log(`Table '${TABLE_NAME}' already exists.`);
      return;
    }

    // Create table
    const response = await client.send(new CreateTableCommand(tableParams));
    console.log(`Table '${TABLE_NAME}' created successfully:`, response);
  } catch (error) {
    console.error('Error creating table:', error);
  }
}

// Main execution
export async function setupDynamoDBLocal(): Promise<void> {
  console.log(`Setting up DynamoDB local table '${TABLE_NAME}' at ${ENDPOINT}...`);
  await createTable();
  console.log('Setup complete.');
}

// If this script is run directly
if (require.main === module) {
  setupDynamoDBLocal().catch((err) => console.error('Setup failed:', err));
}
