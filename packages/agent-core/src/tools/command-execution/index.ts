import { spawn } from 'child_process';
import { authorizeGitHubCli } from './github';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { ToolDefinition, truncate, zodToJsonSchemaBody } from '../../private/common/lib';
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
});

export const DefaultWorkingDirectory = join(homedir(), `.remote-swe-workspace`);
spawn('mkdir', ['-p', DefaultWorkingDirectory]);

export const executeCommand = async (command: string, cwd?: string, timeout = 60000, longRunningProcess = false) => {
  const token = await authorizeGitHubCli();
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
        GITHUB_TOKEN: token,
      },
    });

    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout;
    let longRunningTimer: NodeJS.Timeout | undefined;
    let hasExited = false;

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Only kill the process if it's not a long-running one
        if (!longRunningProcess) {
          childProcess.kill();
          resolve({
            error: `Command execution timed out after ${Math.round(timeout / 1000)} seconds of inactivity`,
            stdout: truncate(stdout, 40e3),
            stderr: truncate(stderr),
            suggestion: generateSuggestion(command, false),
          });
        }
      }, timeout);
    };

    resetTimer();

    // For long-running processes, we wait for 10 seconds and then return control to the agent
    if (longRunningProcess) {
      longRunningTimer = setTimeout(() => {
        if (!hasExited) {
          console.log(`Returning control to agent after 10 seconds for long-running process: ${command}`);
          resolve({
            stdout: truncate(stdout, 40e3),
            stderr: truncate(stderr),
            isLongRunning: true,
            suggestion: generateSuggestion(command, true),
          });
        }
      }, 10000); // 10 seconds
    }

    childProcess.on('error', (error) => {
      clearTimeout(timer);
      if (longRunningTimer) clearTimeout(longRunningTimer);
      hasExited = true;
      resolve({
        error: `Failed to interact with the process: ${error.message}`,
        stdout: truncate(stdout, 40e3),
        stderr: truncate(stderr),
        suggestion: generateSuggestion(command, false),
      });
    });

    childProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      resetTimer();
    });

    childProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      resetTimer();
    });

    childProcess.on('close', (code) => {
      clearTimeout(timer);
      if (longRunningTimer) clearTimeout(longRunningTimer);
      hasExited = true;

      // If the process exits within the 10 seconds window for long-running processes,
      // we should report that instead of leaving it running
      if (code === 0) {
        resolve({
          stdout: truncate(stdout, 40e3),
          stderr: truncate(stderr),
          suggestion: generateSuggestion(command, true),
        });
      } else {
        resolve({
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

const handler = async (input: { command: string; cwd?: string; longRunningProcess?: boolean }) => {
  const res = await executeCommand(input.command, input.cwd, 60000, input.longRunningProcess);
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

IMPORTANT: When your command contains special characters (like backticks, quotes, dollar signs), they need to be properly escaped to prevent shell interpretation. Common approaches:
1. Use single quotes to prevent variable expansion and most interpretations: 'text with $HOME and \`backticks\`'
2. Escape special characters with backslash: "text with \\$HOME and \\\`backticks\\\`"

IMPORTANT FOR GITHUB PR/ISSUES: When creating GitHub PRs or issues with markdown formatting:
1. Use heredoc for proper markdown rendering (especially for multi-line content):
   gh pr create --title "Title" --body "$(cat <<EOF
   # Heading

   Description text
   
   ## Changes
   
   * Item 1
   * Item 2
   EOF
   )"
2. Ensure proper spacing in markdown:
   - Always add empty lines between sections
   - Add an empty line before lists
   - Properly indent nested content
3. When escaping quotes within heredocs, use: \\"quoted text\\"

Some example commands:
* \`ls\`: list files in a directory
* \`cat\`: read the content of a file
* \`grep\`: search through contents in files
* \`gh\`: interact with GitHub API (it is already authorized)
  * \`gh issue view ISSUE_NUMBER\`: view a repository issue

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
