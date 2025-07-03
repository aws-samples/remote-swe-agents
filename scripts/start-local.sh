#!/bin/bash

# Load environment variables from .env.local if exists
if [ -f .env.local ]; then
  export $(grep -v '^#' .env.local | xargs)
  echo "Loaded environment variables from .env.local"
else
  echo "Warning: .env.local file not found. Using default values."
  export DYNAMODB_ENDPOINT=http://localhost:8000
  export TABLE_NAME=RemoteSWEAgentsTable-local
  export AWS_REGION=ap-northeast-1
  export AWS_ACCESS_KEY_ID=local
  export AWS_SECRET_ACCESS_KEY=local
  export WORKER_ID=local-worker
fi

# Check if DynamoDB Local is running
if curl -s http://localhost:8000 > /dev/null; then
  echo "DynamoDB Local is running"
else
  echo "Starting DynamoDB Local using Docker Compose..."
  docker-compose up -d dynamodb-local dynamodb-admin
  
  # Wait for DynamoDB Local to start
  echo "Waiting for DynamoDB Local to start..."
  until curl -s http://localhost:8000 > /dev/null; do
    echo "."
    sleep 1
  done
  echo "DynamoDB Local is running"
fi

# Run setup script to create the table
echo "Setting up DynamoDB Local table..."
node scripts/setup-dynamodb-local.js

# Build and start the worker
echo "Building agent-core..."
npm run build -w @remote-swe-agents/agent-core

echo "Starting local worker..."
cd packages/worker && npm run start:local