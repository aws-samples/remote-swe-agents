import { spawn } from 'child_process';
import { authorizeGitHubCli } from './github';
export { isGitHubConfigured } from './github';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { z } from 'zod';
import { CancellationToken, ToolDefinition, truncate, zodToJsonSchemaBody } from '../../private/common/lib';
import { generateSuggestion } from './suggestion';

const inputSchema = z.object({
  command: z.string().describe('The command to execute.'),
  cwd: z.string().optional().describe('The current working directory to execute the command in.'),
  longRunningProcess: z
    .boolean()
    .optional()
    .describe(
      'If true, do not wait for the process to exit; leave the process running and return control after 10 seconds.'
    ),
  timeoutMs: z
    .number()
    .optional()
    .describe('Custom timeout in milliseconds for command execution. Default is 60000ms (60 seconds).'),
});

export const DefaultWorkingDirectory = join(homedir(), `.remote-swe-workspace`);
spawn('mkdir', ['-p', DefaultWorkingDirectory]);

export const PID_DIR = join(tmpdir(), '.remote-swe-pids');
mkdirSync(PID_DIR, { recursive: true });

const savePidFile = (toolUseId: string, pid: number, command: string) => {
  try {
    writeFileSync(join(PID_DIR, toolUseId), JSON.stringify({ pid, command }));
  } catch (e) {
    console.log(`Failed to write PID file for ${toolUseId}: ${e}`);
  }
};

const removePidFile = (toolUseId: string) => {
  try {
    unlinkSync(join(PID_DIR, toolUseId));
  } catch {
    // file may already be deleted
  }
};

export const executeCommand = async (
  command: string,
  cwd?: string,
  timeoutMs = 60000,
  longRunningProcess = false,
  toolUseId?: string,
  cancellationToken?: CancellationToken
) => {
  // Ignore error when github token is not available
  const token = await authorizeGitHubCli().catch((e) => console.log(e));

  cwd = cwd ?? DefaultWorkingDirectory;

  return new Promise<{
    stdout: string;
    stderr: string;
    error?: string;
    exitCode?: number;
    suggestion?: string;
    isLongRunning?: boolean;
  }>((resolve) => {
    console.log(`Executing command: ${command} in ${cwd}`);
    const childProcess = spawn(command, [], {
      cwd,
      shell: true,
      env: {
        ...process.env,
        GITHUB_TOKEN: token ?? '',
      },
    });

    if (toolUseId && childProcess.pid) {
      savePidFile(toolUseId, childProcess.pid, command);
    }

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout;
    let longRunningTimer: NodeJS.Timeout | undefined;
    let cancellationInterval: NodeJS.Timeout | undefined;
    let hasExited = false;
    let resolved = false;

    const safeResolve = (result: {
      stdout: string;
      stderr: string;
      error?: string;
      exitCode?: number;
      suggestion?: string;
      isLongRunning?: boolean;
    }) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const resetTimer = () => {
      if (resolved) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Only kill the process if it's not a long-running one and not already resolved
        if (!longRunningProcess && !resolved) {
          clearTimeout(timer);
          if (longRunningTimer) clearTimeout(longRunningTimer);
          if (cancellationInterval) clearInterval(cancellationInterval);
          hasExited = true;
          if (toolUseId) removePidFile(toolUseId);
          childProcess.kill();
          safeResolve({
            error: `Command execution timed out after ${Math.round(timeoutMs / 1000)} seconds of inactivity`,
            stdout: truncate(stdout, 40e3),
            stderr: truncate(stderr),
            suggestion: generateSuggestion(command, false),
          });
        }
      }, timeoutMs);
    };

    resetTimer();

    // For long-running processes, we wait for 10 seconds and then return control to the agent
    if (longRunningProcess) {
      longRunningTimer = setTimeout(() => {
        if (!hasExited) {
          console.log(`Returning control to agent after 10 seconds for long-running process: ${command}`);
          safeResolve({
            stdout: truncate(stdout, 40e3),
            stderr: truncate(stderr),
            isLongRunning: true,
            suggestion: generateSuggestion(command, true),
          });
        }
      }, 10000); // 10 seconds
    }

    if (cancellationToken) {
      cancellationInterval = setInterval(() => {
        if (cancellationToken.isCancelled && !hasExited) {
          console.log(
            `Cancellation requested, leaving process running in background for command: ${command} (PID: ${childProcess.pid})`
          );
          clearTimeout(timer);
          if (longRunningTimer) clearTimeout(longRunningTimer);
          clearInterval(cancellationInterval!);
          // Do NOT kill the process — let it continue in background
          // Do NOT remove PID file — process is still running
          safeResolve({
            stdout: truncate(stdout, 40e3),
            stderr: truncate(stderr),
            error: `Command is still running in background (PID: ${childProcess.pid}). The agent session was interrupted by a new incoming message.`,
          });
        }
      }, 100);
    }

    childProcess.on('error', (error) => {
      clearTimeout(timer);
      if (longRunningTimer) clearTimeout(longRunningTimer);
      if (cancellationInterval) clearInterval(cancellationInterval);
      hasExited = true;
      if (toolUseId) removePidFile(toolUseId);
      safeResolve({
        error: `Failed to interact with the process: ${error.message}`,
        stdout: truncate(stdout, 40e3),
        stderr: truncate(stderr),
        suggestion: generateSuggestion(command, false),
      });
    });

    childProcess.stdout.on('data', (data) => {
      if (resolved) return;
      stdout += data.toString();
      resetTimer();
    });

    childProcess.stderr.on('data', (data) => {
      if (resolved) return;
      stderr += data.toString();
      resetTimer();
    });

    childProcess.on('close', (code) => {
      clearTimeout(timer);
      if (longRunningTimer) clearTimeout(longRunningTimer);
      if (cancellationInterval) clearInterval(cancellationInterval);
      hasExited = true;
      if (toolUseId) removePidFile(toolUseId);

      // If the process exits within the 10 seconds window for long-running processes,
      // we should report that instead of leaving it running
      if (code === 0) {
        safeResolve({
          stdout: truncate(stdout, 40e3),
          stderr: truncate(stderr),
          suggestion: generateSuggestion(command, true),
        });
      } else {
        safeResolve({
          error: `Command failed with exit code ${code}`,
          exitCode: code!,
          stdout: truncate(stdout, 40e3),
          stderr: truncate(stderr),
          suggestion: generateSuggestion(command, false),
        });
      }
    });
  });
};

const handler = async (
  input: { command: string; cwd?: string; longRunningProcess?: boolean; timeoutMs?: number },
  context: { toolUseId: string; cancellationToken?: CancellationToken }
) => {
  // Validate that timeoutMs and longRunningProcess are not used together
  if (input.timeoutMs !== undefined && input.longRunningProcess === true) {
    throw new Error(
      "Cannot use both 'timeoutMs' and 'longRunningProcess' options together. Use 'timeoutMs' for one-time tasks that need longer execution time, and 'longRunningProcess' for daemon processes that should continue running in the background."
    );
  }

  const res = await executeCommand(
    input.command,
    input.cwd,
    input.timeoutMs ?? 60000,
    input.longRunningProcess,
    context.toolUseId,
    context.cancellationToken
  );
  return JSON.stringify(res, undefined, 1);
};

const name = 'executeCommand';

export const commandExecutionTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler,
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Execute any shell command. If you need to run a command in a specific directory, set \`cwd\` argument (optional).

If you need to run a daemon or long-running process like \`npm run dev\` or \`docker compose up\`, set \`longRunningProcess: true\`. This will start the process, wait for 10 seconds to allow it to initialize, and return control to you while keeping the process running in the background.

For one-time tasks that you expect to take longer than 60 seconds to complete, set \`timeoutMs\` to a higher value (in milliseconds). For example, \`timeoutMs: 180000\` for a 3-minute timeout. Do NOT use this for daemon processes - use \`longRunningProcess: true\` instead.

IMPORTANT: When your command contains special characters (like backticks, quotes, dollar signs), they need to be properly escaped to prevent shell interpretation. Common approaches:
1. Use single quotes to prevent variable expansion and most interpretations: 'text with $HOME and \`backticks\`'
2. Escape special characters with backslash: "text with \\$HOME and \\\`backticks\\\`"

Some example commands:
* \`ls\`: list files in a directory
* \`cat\`: read the content of a file
* \`grep\`: search through contents in files
* \`gh\`: interact with GitHub API (it is already authorized)
  * \`gh issue view ISSUE_NUMBER\`: view a repository issue
  * \`gh pr-review\`: PR inline review (threads, comments). Always use \`-R owner/repo\` and PR number. Commands:
    - **View** review/threads (JSON): \`gh pr-review review view -R owner/repo --pr N\`. Optional: \`--unresolved\`, \`--not_outdated\`, \`--reviewer LOGIN\`, \`--states CHANGES_REQUESTED,APPROVED\`, \`--tail 2\` (last N replies), \`--include-comment-node-id\`. Returns \`thread_id\` (PRRT_...) for reply/resolve.
    - **Start** pending review: \`gh pr-review review --start -R owner/repo N\`. Returns \`id\` (PRR_...); save it for add-comment and submit.
    - **Add** inline comment (needs PRR_... from start): \`gh pr-review review --add-comment -R owner/repo N --review-id PRR_xxx --path path/to/file --line LINE --body "comment text"\`.
    - **Reply** to a thread (use thread_id from view): \`gh pr-review comments reply N -R owner/repo --thread-id PRRT_xxx --body "reply text"\`. If replying in your own pending review, add \`--review-id PRR_xxx\`.
    - **Submit** review (needs same PRR_... from start): \`gh pr-review review --submit -R owner/repo N --review-id PRR_xxx --event EVENT --body "summary"\`. EVENT: \`APPROVE\` | \`REQUEST_CHANGES\` | \`COMMENT\`.
    - **List** threads: \`gh pr-review threads list -R owner/repo N\`. Optional: \`--unresolved\`, \`--mine\`. Returns \`threadId\` for resolve.
    - **Resolve** thread: \`gh pr-review threads resolve -R owner/repo N --thread-id PRRT_xxx\`.

IMPORTANT: Sometimes the tool result object contains "suggestion" property reflecting the command execution result. When you see it, you must follow the suggested actions.
`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};

// (async () => {
//   const res = await executeCommand('foo');
//   console.log(res);
// })();
