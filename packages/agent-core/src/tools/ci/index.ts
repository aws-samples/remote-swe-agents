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

interface ActionsRun {
  runId: string;
  name: string;
}

interface ExternalCheck {
  name: string;
  link: string;
  state: string;
}

interface CheckStatusInProgress {
  status: 'in_progress';
}

interface CheckStatusSuccess {
  status: 'success';
}

interface CheckStatusFailure {
  status: 'failure';
  failedActionsRuns: ActionsRun[];
  failedExternalChecks: ExternalCheck[];
}

type CheckStatusResult = CheckStatusInProgress | CheckStatusSuccess | CheckStatusFailure;

const isActionsRunLink = (link: string | null | undefined): boolean => {
  return !!link && link.includes('/actions/runs/');
};

const extractRunId = (link: string): string | undefined => {
  const parts = link.split('/actions/runs/');
  if (parts.length < 2) return undefined;
  return parts[1].split('/')[0];
};

const getLatestRunResult = async (input: { owner: string; repo: string; pullRequestId: string }) => {
  const { owner, repo, pullRequestId } = input;
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
        const parts: string[] = [];

        if (checkResult.failedActionsRuns.length > 0) {
          const firstRun = checkResult.failedActionsRuns[0];
          const result: string = await execute(`gh run view ${firstRun.runId} -R ${owner}/${repo}`, true);
          const logs: string = await execute(`gh run view ${firstRun.runId} -R ${owner}/${repo} --log-failed`, true);
          const formattedLogs = logs
            .split('\n')
            .map((l) => l.split('\t').at(-1))
            .join('\n');
          parts.push(
            `CI failed with errors! <detail>${result}</detail>\n\nHere's the result of gh run view --log-failed:<log>${formattedLogs}</log>`
          );
        }

        if (checkResult.failedExternalChecks.length > 0) {
          const externalSummary = checkResult.failedExternalChecks
            .map((c) => `- ${c.name} (${c.state}): ${c.link}`)
            .join('\n');
          parts.push(`External checks failed:\n${externalSummary}`);
        }

        return parts.join('\n\n');
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

export const getPrCheckStatus = async (
  owner: string,
  repo: string,
  pullRequestId: string
): Promise<CheckStatusResult> => {
  const checks = (await execute(
    `gh pr checks -R ${owner}/${repo} ${pullRequestId} --json state,name,workflow,link,bucket`
  )) as { link: string; name: string; state: string; workflow: string; bucket: string }[];

  if (!checks || checks.length === 0) {
    throw new Error('No checks found for this PR');
  }

  const runningChecks = checks.filter((check) => ['pending'].includes(check.bucket));

  if (runningChecks.length > 0) {
    return { status: 'in_progress' };
  }

  const failedChecks = checks.filter((check) => check.bucket === 'fail');
  if (failedChecks.length === 0) {
    // cancel/skipping → treated as success
    return { status: 'success' };
  }

  const failedActionsRuns: ActionsRun[] = [];
  const seenRunIds = new Set<string>();
  const failedExternalChecks: ExternalCheck[] = [];

  for (const check of failedChecks) {
    if (isActionsRunLink(check.link)) {
      const runId = extractRunId(check.link);
      if (runId && !seenRunIds.has(runId)) {
        seenRunIds.add(runId);
        failedActionsRuns.push({ runId, name: check.name });
      } else if (!runId) {
        failedExternalChecks.push({ name: check.name, link: check.link, state: check.state });
      }
    } else {
      failedExternalChecks.push({ name: check.name, link: check.link, state: check.state });
    }
  }

  return { status: 'failure', failedActionsRuns, failedExternalChecks };
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
