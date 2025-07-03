import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
  ScalarAttributeType,
  KeyType,
  ProjectionType,
  BillingMode,
} from '@aws-sdk/client-dynamodb';

const Endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const TableName = process.env.TABLE_NAME ?? 'RemoteSWEAgentsTable-local';

const client = new DynamoDBClient({
  endpoint: Endpoint,
});

const tableParams = {
  TableName,
  AttributeDefinitions: [
    {
      AttributeName: 'PK',
      AttributeType: ScalarAttributeType.S,
    },
    {
      AttributeName: 'SK',
      AttributeType: ScalarAttributeType.S,
    },
    {
      AttributeName: 'LSI1',
      AttributeType: ScalarAttributeType.S,
    },
  ],
  KeySchema: [
    {
      AttributeName: 'PK',
      KeyType: KeyType.HASH,
    },
    {
      AttributeName: 'SK',
      KeyType: KeyType.RANGE,
    },
  ],
  LocalSecondaryIndexes: [
    {
      IndexName: 'LSI1',
      KeySchema: [
        {
          AttributeName: 'PK',
          KeyType: KeyType.HASH,
        },
        {
          AttributeName: 'LSI1',
          KeyType: KeyType.RANGE,
        },
      ],
      Projection: {
        ProjectionType: ProjectionType.ALL,
      },
    },
  ],
  BillingMode: BillingMode.PAY_PER_REQUEST,
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
    const tableExists = await checkTableExists(TableName);

    if (tableExists) {
      console.log(`Table '${TableName}' already exists.`);
      return;
    }

    const response = await client.send(new CreateTableCommand(tableParams));
    console.log(`Table '${TableName}' created successfully:`, response);
  } catch (error) {
    console.error('Error creating table:', error);
  }
}

export async function setupDynamoDBLocal(): Promise<void> {
  console.log(`Setting up DynamoDB local table '${TableName}' at ${Endpoint}...`);
  await createTable();
  console.log('Setup complete.');
}

if (require.main === module) {
  setupDynamoDBLocal().catch((err) => console.error('Setup failed:', err));
}
