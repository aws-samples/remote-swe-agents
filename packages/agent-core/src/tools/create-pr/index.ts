import { z } from 'zod';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { executeCommand } from '../command-execution';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '../../lib/aws/ddb';
import { ciTool } from '../ci';
import { appendWorkerIdMetadata } from '../../lib/worker-id';

const inputSchema = z.object({
  title: z.string().describe('Title of the pull request'),
  description: z.string().describe('Description of the pull request (must be formatted with markdown)'),
  issueId: z.number().optional().describe('Optional issue ID to link with the PR'),
  force: z.boolean().default(false).describe('Ignore duplicate validation and create PR anyway'),
  gitDirectoryPath: z.string().describe('The absolute path to the git local repository'),
});

interface PRRecord {
  PK: string;
  SK: string;
  type: 'pr';
  url: string;
  branchName: string;
}

const execute = async (command: string, cwd: string): Promise<string> => {
  const res = await executeCommand(command, cwd);

  if (res.error != null) {
    throw new Error(`Command failed: ${command}\n${JSON.stringify(res)}`);
  }
  return res.stdout.trim();
};

const checkExistingPR = async (workerId: string): Promise<PRRecord | null> => {
  const result = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `artifact-${workerId}`,
        ':skPrefix': 'pr-',
      },
      Limit: 1,
    })
  );

  return result.Items && result.Items.length > 0 ? (result.Items[0] as PRRecord) : null;
};

const storePRRecord = async (workerId: string, url: string, branchName: string) => {
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: `artifact-${workerId}`,
        SK: `pr-${url}`,
        type: 'pr',
        url,
        branchName,
      } satisfies PRRecord,
    })
  );
};

const addIssueReference = (description: string, issueId: number): string => {
  const closePatterns = [
    `closes #${issueId}`,
    `close #${issueId}`,
    `closed #${issueId}`,
    `fixes #${issueId}`,
    `fix #${issueId}`,
    `fixed #${issueId}`,
    `resolves #${issueId}`,
    `resolve #${issueId}`,
    `resolved #${issueId}`,
  ];

  const hasCloseReference = closePatterns.some((pattern) => description.toLowerCase().includes(pattern.toLowerCase()));

  if (!hasCloseReference) {
    return `${description}\n\nCloses #${issueId}`;
  }

  return description;
};

const createPullRequest = async (input: z.infer<typeof inputSchema>) => {
  const { title, description, issueId, force, gitDirectoryPath } = input;
  const workerId = process.env.WORKER_ID!;

  // Check for existing PR unless force is true
  if (!force) {
    const existingPR = await checkExistingPR(workerId);
    if (existingPR) {
      throw new Error(
        `A pull request has already been created in this session: ${existingPR.url}\n\n` +
          `Suggested actions:\n` +
          `- If this is not intended, just push commits to the existing branch "${existingPR.branchName}"\n` +
          `- If this is intended, use the force flag when calling this tool`
      );
    }
  }

  // Get current branch name
  const branchName = await execute('git rev-parse --abbrev-ref HEAD', gitDirectoryPath);

  // Push the current branch to origin before creating PR
  try {
    await execute(`git push -u origin ${branchName}`, gitDirectoryPath);
  } catch (error) {
    throw new Error(`Failed to push branch to origin: ${(error as Error).message}`);
  }

  // Add issue reference if issueId is provided
  let finalDescription = description;
  if (issueId) {
    finalDescription = addIssueReference(description, issueId);
  }

  // Embed workerId as HTML comment (invisible to users)
  // Regex to search the PR id: /<!-- WORKER_ID:([^-]+) -->/
  finalDescription = appendWorkerIdMetadata(finalDescription);

  // Create markdown file in /tmp to avoid escape issues
  const tempFile = join('/tmp', `pr-description-${Date.now()}.md`);
  writeFileSync(tempFile, finalDescription);

  try {
    // Create pull request using gh CLI
    const prUrl = await execute(`gh pr create --title "${title}" --body-file "${tempFile}"`, gitDirectoryPath);

    // Store PR record in DynamoDB
    await storePRRecord(workerId, prUrl, branchName);

    return `Pull request created successfully: ${prUrl}
Suggestion: When you successfully created a PR, make sure you report its URL to the user. Also check the CI status by using ${ciTool.name} tool and fix the code until all of the CI steps pass.
`.trim();
  } catch (error) {
    throw new Error(`Failed to create pull request: ${(error as Error).message}`);
  }
};

const name = 'createPullRequest';

export const createPRTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: createPullRequest,
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description:
      `Create a new pull request of your branch to the upstream. This tool automatically pushes your current branch to the remote repository before creating the PR. Make sure to commit your changes before running this tool. This tool tracks PRs created in the session and prevents duplicate PRs unless forced. When your PR is linked to an issue, always provide the issue id as well.
    `.trim(),
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
