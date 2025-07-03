# Worker

This is the agent implementation that works in its own EC2 environment.

## Run locally

You can run the agent locally using the below command. Note that you must provide `BUCKET_NAME` and `TABLE_NAME` using the actual ARN. 

```sh
cd packages/common
npm run watch
```

```sh
export BUCKET_NAME=remoteswestack-sandbox-storageimagebucket99ba9550-xxxxxxx
export TABLE_NAME=RemoteSweStack-Sandbox-StorageHistory251A3AE8-xxxxxx
export EVENT_HTTP_ENDPOINT="https://API_ID.appsync-api.ap-northeast-1.amazonaws.com"
export GITHUB_PERSONAL_ACCESS_TOKEN='dummy'
export BEDROCK_AWS_ACCOUNTS='475977027832'
npx tsx src/local.ts
```

## Local Development with DynamoDB Local

For local development, you can use DynamoDB Local to avoid depending on an AWS account.

### Prerequisites

- Node.js (v18 or later)
- Docker and Docker Compose
- Git
- OpenAI API key (required for running the agent locally)

### Setup Steps

1. Install dependencies:
```bash
npm ci
```

2. Start DynamoDB Local and the worker:
```bash
# From the packages/worker directory
npm run start:local:dynamodb
```

This script performs the following:
1. Starts DynamoDB Local and DynamoDB Admin using Docker Compose
2. Creates tables in DynamoDB Local
3. Builds the agent-core module
4. Starts the local worker

The script sets the following environment variables automatically:
```
DYNAMODB_ENDPOINT=http://localhost:8000
TABLE_NAME=RemoteSWEAgentsTable-local
AWS_REGION=ap-northeast-1
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
WORKER_ID=local-worker
```

### Manual Setup (Alternative)

If you prefer to start components individually:

1. Start DynamoDB Local and DynamoDB Admin:
```bash
# From the repository root
docker-compose up -d dynamodb-local dynamodb-admin
```

2. Create tables:
```bash
# From the packages/worker directory
DYNAMODB_ENDPOINT=http://localhost:8000 TABLE_NAME=RemoteSWEAgentsTable-local tsx scripts/setup-dynamodb-local.ts
```

3. Build agent-core:
```bash
# From the repository root
npm run build -w @remote-swe-agents/agent-core
```

4. Start the worker:
```bash
# From the packages/worker directory
DYNAMODB_ENDPOINT=http://localhost:8000 TABLE_NAME=RemoteSWEAgentsTable-local WORKER_ID=local-worker npm run start:local
```

### Usage

Once the local worker is started, you can interact with the agent through the command-line interface. Follow the prompts to enter messages.

### DynamoDB Admin Interface

DynamoDB Admin is accessible at `http://localhost:8001`. You can use this web interface to view and manipulate data in the tables.

### Troubleshooting

#### Cannot Connect to DynamoDB Local
- Check if Docker Compose is running properly
- Use the `docker ps` command to verify the `dynamodb-local` container is running
- Check if port 8000 is being used by another application

#### Table Creation Error
- Verify DynamoDB Local is running
- Check if the environment variables are set correctly

#### Worker Won't Start
- Verify the agent-core module is built correctly
- Set the OPENAI_API_KEY environment variable if you're using OpenAI models
