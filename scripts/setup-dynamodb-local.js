#!/usr/bin/env node

/**
 * This script sets up the necessary DynamoDB local table for development.
 * Run this script after starting DynamoDB Local with docker-compose.
 */

const { DynamoDBClient, CreateTableCommand, ListTablesCommand } = require('@aws-sdk/client-dynamodb');

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
      AttributeType: 'S',
    },
    {
      AttributeName: 'sk',
      AttributeType: 'S',
    },
    {
      AttributeName: 'gsi1pk',
      AttributeType: 'S',
    },
    {
      AttributeName: 'gsi1sk',
      AttributeType: 'S',
    },
  ],
  KeySchema: [
    {
      AttributeName: 'pk',
      KeyType: 'HASH',
    },
    {
      AttributeName: 'sk',
      KeyType: 'RANGE',
    },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'gsi1',
      KeySchema: [
        {
          AttributeName: 'gsi1pk',
          KeyType: 'HASH',
        },
        {
          AttributeName: 'gsi1sk',
          KeyType: 'RANGE',
        },
      ],
      Projection: {
        ProjectionType: 'ALL',
      },
      ProvisionedThroughput: {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5,
      },
    },
  ],
  BillingMode: 'PROVISIONED',
  ProvisionedThroughput: {
    ReadCapacityUnits: 5,
    WriteCapacityUnits: 5,
  },
};

async function checkTableExists(tableName) {
  try {
    const { TableNames } = await client.send(new ListTablesCommand({}));
    return TableNames.includes(tableName);
  } catch (error) {
    console.error('Error checking if table exists:', error);
    return false;
  }
}

async function createTable() {
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
console.log(`Setting up DynamoDB local table '${TABLE_NAME}' at ${ENDPOINT}...`);
createTable()
  .then(() => console.log('Setup complete.'))
  .catch((err) => console.error('Setup failed:', err));