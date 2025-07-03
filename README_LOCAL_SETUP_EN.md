# Local Development Environment Setup Guide

This guide explains how to set up and test Remote SWE Agents in a local development environment. Specifically, it introduces how to set up a complete local development environment using DynamoDB Local without depending on an AWS account.

## Prerequisites

- Node.js (v18 or later)
- Docker and Docker Compose
- Git
- OpenAI API key (required for running the agent locally)

## Setup Steps

### 1. Clone the Repository

```bash
git clone https://github.com/aws-samples/remote-swe-agents.git
cd remote-swe-agents
```

### 2. Install Dependencies

```bash
npm ci
```

### 3. Configure Environment Variables

Copy the `.env.local.example` file as `.env.local` and set the necessary environment variables:

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and set at least the following values:

```
# Default DynamoDB Local settings should work fine
DYNAMODB_ENDPOINT=http://localhost:8000
TABLE_NAME=RemoteSWEAgentsTable-local
AWS_REGION=ap-northeast-1

# AWS credentials for local development (any values are fine for DynamoDB Local)
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local

# Worker configuration
WORKER_ID=local-worker

# OpenAI API configuration (set your actual API key)
OPENAI_API_KEY=your_openai_api_key
```

### 4. Start DynamoDB Local and the Worker

You can use the provided script to start DynamoDB Local, create tables, and start the worker at once:

```bash
./scripts/start-local.sh
```

This script performs the following:

1. Loads environment variables from `.env.local`
2. Starts DynamoDB Local and DynamoDB Admin using Docker Compose
3. Creates tables in DynamoDB Local
4. Builds the agent-core module
5. Starts the local worker

### 5. Start Individual Components (Optional)

If you want to start components individually, run the following commands:

#### Start DynamoDB Local and DynamoDB Admin

```bash
docker-compose up -d dynamodb-local dynamodb-admin
```

DynamoDB Admin is accessible at `http://localhost:8001`.

#### Create Tables

```bash
node scripts/setup-dynamodb-local.js
```

#### Build agent-core

```bash
npm run build -w @remote-swe-agents/agent-core
```

#### Start the Worker

```bash
cd packages/worker && npm run start:local
```

## Usage

Once the local worker is started, you can interact with the agent through the command-line interface. Follow the prompts to enter messages.

## Checking DynamoDB Data

You can use the DynamoDB Admin interface (`http://localhost:8001`) to view and manipulate data in the tables.

## Troubleshooting

### Cannot Connect to DynamoDB Local

- Check if Docker Compose is running properly
- Use the `docker ps` command to verify the `dynamodb-local` container is running
- Check if port 8000 is being used by another application

### Table Creation Error

- Verify DynamoDB Local is running
- Check if the `DYNAMODB_ENDPOINT` environment variable is set correctly

### Worker Won't Start

- Verify the agent-core module is built correctly
- Check if environment variables are set correctly (especially `TABLE_NAME` and `OPENAI_API_KEY`)

## Resources

- [DynamoDB Local Official Documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html)
- [Remote SWE Agents Documentation](https://github.com/aws-samples/remote-swe-agents)