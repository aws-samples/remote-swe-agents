import { setTimeout } from 'timers/promises';
import { executeCommand } from '../command-execution';
import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';

const inputSchema = z.object({
  owner: z.string().describe('GitHub repository owner'),
  repo: z.string().describe('GitHub repository name'),
  pullRequestId: z
    .string()
    .describe('The sequential number of the pull request issued from GitHub, or the branch name.'),
});

const getLatestRunResult = async (input: { owner: string; repo: string; pullRequestId: string }) => {
  const { owner, repo, pullRequestId } = input;
  // If it is executed too soon, the workflow might not be queued yet, resulting in an empty success.
  // To avoid it, we wait a bit here.
  await setTimeout(5000);

  while (true) {
    try {
      const checkResult = await getPrCheckStatus(owner, repo, pullRequestId);
      if (checkResult.status === 'in_progress') {
        await setTimeout(5000);
        continue;
      }
      if (checkResult.status === 'success') {
        return `CI succeeded without errors!`;
      } else if (checkResult.status === 'failure') {
        const failed = checkResult.failedRuns;
        const result: string = await execute(`gh run view ${failed[0].runId} -R ${owner}/${repo}`, true);
        const logs: string = await execute(`gh run view ${failed[0].runId} -R ${owner}/${repo} --log-failed`, true);
        logs
          .split('\n')
          .map((l) => l.split('\t').at(-1))
          .join('\n');
        return `CI failed with errors! <detail>${result}</detail>\n\nHere's the result of gh run view --log-failed:<log>${logs}</logs>`;
      }
    } catch (e) {
      console.log(e);
      return `getLatestRunResult failed: ${(e as Error).message}`;
    }
  }
};

const execute = async (command: string, plain = false): Promise<any> => {
  const res = await executeCommand(command);

  if (res.error != null) {
    throw new Error(JSON.stringify(res));
  }
  if (plain) {
    return res.stdout;
  }
  const parsed = JSON.parse(res.stdout);
  return parsed;
};

const getPrCheckStatus = async (
  owner: string,
  repo: string,
  pullRequestId: string
): Promise<{ status: 'in_progress' | 'success' } | { status: 'failure'; failedRuns: { runId: string }[] }> => {
  // Use gh pr checks to get all check runs for the PR
  const checks = (await execute(
    `gh pr checks -R ${owner}/${repo} ${pullRequestId} --json state,name,workflow,link,bucket`
  )) as { link: string; name: string; state: string; workflow: string; bucket: string }[];

  if (!checks || checks.length === 0) {
    throw new Error('No checks found for this PR');
  }

  // bucket: pass, fail, pending, skipping, or cancel.
  // Check if any workflow is still running
  // We have to wait all the runs complete because otherwise we cannot get their execution log by gh run view command.
  const runningChecks = checks.filter((check) => ['pending'].includes(check.bucket));

  if (runningChecks.length > 0) {
    return { status: 'in_progress' };
  }

  // Check if there is failed run
  const failedChecks = checks.filter((check) => check.bucket === 'fail');
  const failedRuns = failedChecks.map((check) => {
    const runId = check.link.split('/actions/runs/')[1].split('/')[0];
    return { runId };
  });
  if (failedRuns.length > 0) {
    return { status: 'failure', failedRuns };
  }

  return { status: 'success' };
};

const name = 'getGitHubActionsLatestResult';

export const ciTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: getLatestRunResult,
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Wait for the GitHub Actions workflow to complete and get its status and logs for a specific PR.
IMPORTANT: You should always use this tool after pushing a commit to pull requests unless user requested otherwise.`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
