# Remote SWE Agents Knowledge Base

This file provides important information about the Remote SWE Assistant repository. AI agent references this to support its work on this project.

## Project Structure

This project consists of the following main components:

1. **CDK (AWS Cloud Development Kit)** - `/cdk` directory
   - Infrastructure provisioning code
   - AWS resource definitions (Lambda, DynamoDB, EC2, etc.)

2. **Agent-core** - `/packages/agent-core` directory
   - A common module that is imported from slack-bolt-app/worker/webapp
   - Provides shared functionality through the following export paths:
     - `@remote-swe-agents/agent-core` - Main module
     - `@remote-swe-agents/agent-core/lib` - Common library functions
     - `@remote-swe-agents/agent-core/aws` - AWS related functionality
     - `@remote-swe-agents/agent-core/schema` - Schema definitions (including TodoList types)
     - `@remote-swe-agents/agent-core/tools` - Tool-related functionality
     - `@remote-swe-agents/agent-core/env` - Environment-related functionality
3. **Slack Bolt App** - `/packages/slack-bolt-app` directory
   - Slack integration interface
   - API for processing user requests

4. **Worker** - `/packages/worker` directory
   - AI agent implementation
   - Tool suite (GitHub operations, file editing, command execution, etc.)

5. **Webapp** - `/packages/webapp` directory
   - A Next.js web UI to interact with agents
   
## Next.js Server Actions (Webapp)

### Server Actions Pattern

When implementing server-side functionality in the webapp, always use Next.js server actions instead of API Routes:

1. **Server Action Creation Pattern**:
   ```typescript
   'use server';
   
   import { authActionClient } from '@/lib/safe-action';
   import { myActionSchema } from './schemas';
   
   export const myServerAction = authActionClient
     .schema(myActionSchema)
     .action(async ({ parsedInput: { param1, param2 } }) => {
       // Implement server-side logic
       return result;
     });
   ```

2. **Action Schema Definition**:
   ```typescript
   // schemas.ts
   import { z } from 'zod';
   
   export const myActionSchema = z.object({
     param1: z.string(),
     param2: z.number(),
   });
   ```

3. **Client-side Usage with useAction hook**:
   ```typescript
   'use client';
   
   import { useAction } from 'next-safe-action/hooks';
   import { myServerAction } from '../actions';
   
   // In component:
   const { execute, status, result } = useAction(myServerAction, {
     onSuccess: (data) => {
       // Handle success
     },
     onError: (error) => {
       // Handle error
     }
   });
   
   const handleSubmit = () => {
     execute({ param1: 'value', param2: 42 });
   };
   ```

### Important Notes

- **NEVER** use direct API Routes (app/api/...) when server actions can be used instead
- **ALWAYS** handle both success and error cases in client-side code
- Keep database access code in server actions, not in client components
- Use Zod schemas for validation in server actions
- When dealing with DynamoDB, import from `@remote-swe-agents/agent-core/aws` and use directly in server actions
- The auth middleware automatically protects server actions through `authActionClient`

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
4. Create a PR and ensure CI passes. The PR title and description must always written in English.
5. Request review when the PR is ready (i.e. when you implemented all the requested features and all the CI passes.)

## PR Guidelines

- **Always create PRs against the upstream repository**: When making changes, ensure that your Pull Requests are created against the original repository (`aws-samples/remote-swe-agents`), not your personal fork.
- **Use descriptive PR titles**: PR titles and descriptions should clearly explain the changes and must be written in English.

## Troubleshooting

- **Build errors**: Check that dependencies are up to date (`npm ci` to update)
- **TypeScript errors**: Ensure type definitions are accurate and use type assertions when necessary
- **CDK Snapshot Test Failures**: When modifying infrastructure in CDK, snapshot tests may fail. Update snapshots using `cd cdk && npm run test -- -u`
- **Import errors from agent-core**: Always use the official export paths defined in agent-core's package.json. Do not directly import from internal paths like `@remote-swe-agents/agent-core/lib/todo` or `@remote-swe-agents/agent-core/schema/todo` as these are not officially exported and may cause build failures.
- **Server actions returning void error**: When using `useAction` hook, make sure you're using callbacks for success/error handling rather than directly awaiting the return value. If you see errors like `Property 'data' does not exist on type 'void'`, use the onSuccess/onError pattern shown above.
