# Remote SWE Agents Knowledge Base

This file provides important information about the Remote SWE Assistant repository. AI agent references this to support its work on this project.

## Project Structure

This project consists of the following main components:

1. **CDK (AWS Cloud Development Kit)** - `/cdk` directory
   - Infrastructure provisioning code
   - AWS resource definitions (Lambda, DynamoDB, EC2, etc.)

2. **Agent-core** - `/packages/agent-core` directory
   - A common module that is imported from slack-bolt-app/worker/webapp
   - 
3. **Slack Bolt App** - `/packages/slack-bolt-app` directory
   - Slack integration interface
   - API for processing user requests

4. **Worker** - `/packages/worker` directory
   - AI agent implementation
   - Tool suite (GitHub operations, file editing, command execution, etc.)

5. **Webapp** - `/packages/webapp` directory
   - A Next.js web UI to interact with agents

## Coding Conventions

- Use TypeScript to ensure type safety
- Use Promise-based patterns for asynchronous operations
- Use Prettier for code formatting
- Prefer function-based implementations over classes
- DO NOT write code comments unless the implementation is so complicated or difficult to understand without comments.
- If writing code comments, ALWAYS USE English language.

## Commonly Used Commands

### CDK

```bash
# CDK deployment
cd cdk && npx cdk deploy

# List stacks
cd cdk && npx cdk list

# Check stack differences
cd cdk && npx cdk diff
```

### Common module

You have to ALWAYS build the agent-core module before building worker/slack-bolt-app/webapp.

```bash
cd packages/agent-core && npm run build
```

### Worker

```bash
# Local execution
cd packages/worker && npm run start:local

# build
npm run build -w @remote-swe-agents/agent-core
cd packages/worker && npm run build
```

### Slack Bolt App

```bash
# Run in development mode (watch for changes)
cd packages/slack-bolt-app && npm run dev

# Build
npm run build -w @remote-swe-agents/agent-core
cd packages/slack-bolt-app && npm run build
```

### Webapp

```bash
# Run in development mode
cd packages/webapp && npm run dev

# Build
npm run build -w @remote-swe-agents/agent-core
cd packages/webapp && npm run build
```

## Development Flow

1. Create a branch for a new feature or bug fix
2. Implement changes and test
3. Run format and type checks
4. Create a PR and ensure CI passes. The PR title should always be in English.
5. Request review when the PR is ready (i.e. when you implemented all the requested features and all the CI passes.)

## Troubleshooting

- **Build errors**: Check that dependencies are up to date (`npm ci` to update)
- **TypeScript errors**: Ensure type definitions are accurate and use type assertions when necessary
- **CDK Snapshot Test Failures**: When modifying infrastructure in CDK, snapshot tests may fail. Update snapshots using `cd cdk && npm run test -- -u`
