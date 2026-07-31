import { z } from 'zod';
import { CancellationToken, ToolDefinition, truncate, zodToJsonSchemaBody } from '../../private/common/lib';
import { executeCommand, BACKGROUND_CANCELLATION_MARKER } from '../command-execution';

/**
 * Parse a positive numeric env var, falling back to a default when the value
 * is missing or not a finite positive number.
 */
const numEnv = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Tunable defaults for the wait tool. All are env-overridable so they can be
 * adjusted without a code change.
 *
 * IMPORTANT — these values must stay below the agent turn wall-clock budget.
 * The whole agent turn is bounded by an unconditional wall-clock timeout.
 * A wait tool call holds the turn open for up to `maxWaitSeconds`, so the
 * ceiling MUST stay below that wall-clock with margin, otherwise a long wait
 * gets the whole turn killed mid-flight.
 *
 * The deployed turn wall-clock is ~900s (unconditional), so we keep the
 * ceiling well under it (~540s) and the default lower (~300s). Adjust via
 * the `WAIT_TOOL_*` env vars rather than editing code. Anything longer than
 * the ceiling should hand the turn off via `createEventTrigger`.
 */
export const DEFAULT_MAX_WAIT_SECONDS = numEnv(process.env.WAIT_TOOL_DEFAULT_MAX_WAIT_SECONDS, 300);
export const MAX_WAIT_CEILING_SECONDS = numEnv(process.env.WAIT_TOOL_MAX_WAIT_CEILING_SECONDS, 540);
export const DEFAULT_INITIAL_INTERVAL_MS = numEnv(process.env.WAIT_TOOL_INITIAL_INTERVAL_MS, 5000);
export const DEFAULT_MAX_INTERVAL_MS = numEnv(process.env.WAIT_TOOL_MAX_INTERVAL_MS, 30000);
export const DEFAULT_BACKOFF_MULTIPLIER = numEnv(process.env.WAIT_TOOL_BACKOFF_MULTIPLIER, 2);
export const CHECK_COMMAND_TIMEOUT_MS = numEnv(process.env.WAIT_TOOL_CHECK_COMMAND_TIMEOUT_MS, 60000);

/**
 * Upper bound on the output length fed to the success/fail regexes. Bounds
 * worst-case regex evaluation cost (defensive against pathological/ReDoS-y
 * patterns on huge command output). Self-inflicted risk is low, but cheap to
 * cap.
 */
export const MAX_REGEX_INPUT_CHARS = numEnv(process.env.WAIT_TOOL_MAX_REGEX_INPUT_CHARS, 200_000);

const EXIT0 = 'exit0';

export type WaitOutcome = 'succeeded' | 'failed' | 'timeout' | 'interrupted';

export interface WaitForConditionInput {
  checkCommand: string;
  successWhen: string;
  failWhen?: string;
  maxWaitSeconds?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  backoffMultiplier?: number;
  cwd?: string;
}

export interface WaitForConditionResult {
  outcome: WaitOutcome;
  elapsedSeconds: number;
  checks: number;
  lastExitCode?: number;
  lastStdout: string;
  lastStderr: string;
  message: string;
}

type RunCommandResult = {
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number;
};

/**
 * Dependency seams for testing. Production uses the real `executeCommand`
 * and a wall-clock interruptible sleep; tests inject fakes so they run
 * without real timers or child processes.
 */
export interface WaitForConditionDeps {
  runCommand?: (
    command: string,
    cwd: string | undefined,
    timeoutMs: number,
    cancellationToken?: CancellationToken
  ) => Promise<RunCommandResult>;
  sleep?: (ms: number, cancellationToken?: CancellationToken) => Promise<void>;
  now?: () => number;
}

/**
 * Sleep for `ms`, resolving early (within ~100ms) if the cancellation token
 * flips. Mirrors the polling cadence used by `executeCommand`.
 */
export const interruptibleSleep = (ms: number, cancellationToken?: CancellationToken): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (!cancellationToken) {
      setTimeout(resolve, ms);
      return;
    }
    const start = Date.now();
    const step = Math.min(100, ms);
    const interval = setInterval(() => {
      if (cancellationToken.isCancelled || Date.now() - start >= ms) {
        clearInterval(interval);
        resolve();
      }
    }, step);
  });

const compile = (pattern: string, label: string): RegExp => {
  if (pattern.length === 0) {
    throw new Error(`Invalid ${label} regex: an empty pattern is not allowed (it would match everything).`);
  }
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid ${label} regex "${pattern}": ${e instanceof Error ? e.message : String(e)}`);
  }
};

const buildResult = (
  outcome: WaitOutcome,
  startMs: number,
  nowMs: number,
  checks: number,
  last: { stdout: string; stderr: string; exitCode?: number },
  message: string
): WaitForConditionResult => ({
  outcome,
  elapsedSeconds: Math.round((nowMs - startMs) / 1000),
  checks,
  lastExitCode: last.exitCode,
  lastStdout: truncate(last.stdout, 8e3),
  lastStderr: truncate(last.stderr, 8e3),
  message,
});

/**
 * Poll `checkCommand` with exponential backoff until a success/fail condition
 * is met, the max wait elapses, or the turn is cancelled by a new incoming
 * message. Runs entirely inside a single tool call.
 */
export const waitForCondition = async (
  input: WaitForConditionInput,
  cancellationToken?: CancellationToken,
  deps: WaitForConditionDeps = {}
): Promise<WaitForConditionResult> => {
  const runCommand =
    deps.runCommand ??
    ((command, cwd, timeoutMs, token) => executeCommand(command, cwd, timeoutMs, false, undefined, token));
  const sleep = deps.sleep ?? interruptibleSleep;
  const now = deps.now ?? Date.now;

  const isExit0 = input.successWhen.trim().toLowerCase() === EXIT0;
  const successRe = isExit0 ? undefined : compile(input.successWhen, 'successWhen');
  const failRe = input.failWhen ? compile(input.failWhen, 'failWhen') : undefined;

  const requestedMax = input.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS;
  const cappedMax = Math.min(requestedMax, MAX_WAIT_CEILING_SECONDS);
  const wasCapped = cappedMax < requestedMax;
  const maxWaitMs = cappedMax * 1000;

  let interval = input.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;
  const maxInterval = input.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const multiplier = input.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;

  const capNote = wasCapped
    ? ` (requested ${requestedMax}s was capped to the ${MAX_WAIT_CEILING_SECONDS}s ceiling; for longer waits hand off the turn with createEventTrigger)`
    : '';

  const start = now();
  let checks = 0;
  let last: { stdout: string; stderr: string; exitCode?: number } = { stdout: '', stderr: '', exitCode: undefined };

  while (true) {
    if (cancellationToken?.isCancelled) {
      return buildResult('interrupted', start, now(), checks, last, 'Wait interrupted by a new incoming message.');
    }

    const elapsed = now() - start;
    if (elapsed >= maxWaitMs) {
      return buildResult(
        'timeout',
        start,
        now(),
        checks,
        last,
        `Condition not met within ${cappedMax}s${capNote}. If this is a long-running job, prefer createEventTrigger to release the turn and resume on completion.`
      );
    }

    const remaining = maxWaitMs - elapsed;
    const checkTimeout = Math.max(1000, Math.min(CHECK_COMMAND_TIMEOUT_MS, remaining));
    const res = await runCommand(input.checkCommand, input.cwd, checkTimeout, cancellationToken);
    checks++;
    last = { stdout: res.stdout ?? '', stderr: res.stderr ?? '', exitCode: res.exitCode };

    // executeCommand surfaces a cancelled in-flight command by leaving the
    // process running in the background and returning this sentinel error.
    if (res.error && res.error.includes(BACKGROUND_CANCELLATION_MARKER)) {
      return buildResult('interrupted', start, now(), checks, last, 'Wait interrupted by a new incoming message.');
    }
    if (cancellationToken?.isCancelled) {
      return buildResult('interrupted', start, now(), checks, last, 'Wait interrupted by a new incoming message.');
    }

    // Output fed to the regexes is capped to bound worst-case match cost.
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.slice(0, MAX_REGEX_INPUT_CHARS);
    const exitZero = res.error == null;

    // failWhen takes precedence over successWhen: if both patterns match the
    // same output, the wait fails. Fast-fail is the safer interpretation.
    if (failRe && failRe.test(combined)) {
      return buildResult(
        'failed',
        start,
        now(),
        checks,
        last,
        `failWhen pattern /${input.failWhen}/ matched the check command output.`
      );
    }

    const success = isExit0 ? exitZero : successRe!.test(combined);
    if (success) {
      return buildResult(
        'succeeded',
        start,
        now(),
        checks,
        last,
        isExit0
          ? 'Check command exited 0 (successWhen=exit0).'
          : `successWhen pattern /${input.successWhen}/ matched the check command output.`
      );
    }

    const elapsedAfter = now() - start;
    const remainingAfter = maxWaitMs - elapsedAfter;
    if (remainingAfter <= 0) {
      return buildResult(
        'timeout',
        start,
        now(),
        checks,
        last,
        `Condition not met within ${cappedMax}s${capNote}. If this is a long-running job, prefer createEventTrigger to release the turn and resume on completion.`
      );
    }

    await sleep(Math.min(interval, remainingAfter), cancellationToken);
    interval = Math.min(Math.floor(interval * multiplier), maxInterval);
  }
};

const inputSchema = z.object({
  checkCommand: z
    .string()
    .describe(
      'Shell command run repeatedly to probe the condition (e.g. an `aws ... wait`-style poll, a health check, or a status query).'
    ),
  successWhen: z
    .string()
    .min(1)
    .describe(
      'Success criterion. Use the literal string "exit0" to succeed when checkCommand exits with code 0, or provide a non-empty regular expression matched against the command output (stdout + stderr). An empty string is rejected (it would match everything).'
    ),
  failWhen: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional non-empty regular expression matched against the command output. If it matches, the wait fails immediately (fast-fail). failWhen takes precedence over successWhen when both match.'
    ),
  maxWaitSeconds: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Maximum total seconds to wait (at least 1; at least one check always runs). Default ${DEFAULT_MAX_WAIT_SECONDS}s, hard-capped at ${MAX_WAIT_CEILING_SECONDS}s. For waits longer than the cap, do NOT use this tool — release the turn with createEventTrigger and resume on completion.`
    ),
  initialIntervalMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Initial backoff interval between checks in ms (positive). Default ${DEFAULT_INITIAL_INTERVAL_MS}.`),
  maxIntervalMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum backoff interval between checks in ms (positive). Default ${DEFAULT_MAX_INTERVAL_MS}.`),
  backoffMultiplier: z
    .number()
    .min(1)
    .optional()
    .describe(
      `Backoff growth multiplier applied to the interval after each check (must be >= 1 to avoid a hot loop or shrinking interval). Default ${DEFAULT_BACKOFF_MULTIPLIER}.`
    ),
  cwd: z.string().optional().describe('Working directory to run checkCommand in.'),
});

const handler = async (
  input: z.infer<typeof inputSchema>,
  context: { toolUseId: string; cancellationToken?: CancellationToken }
) => {
  const result = await waitForCondition(input, context.cancellationToken);
  return JSON.stringify(result, undefined, 1);
};

const name = 'waitForCondition';

export const waitForConditionTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler,
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Wait for an asynchronous, long-running external job to reach a terminal state by polling a check command with exponential backoff — all inside a single tool call. Returns once the success/fail condition is met, the max wait elapses, or the turn is interrupted by a new message.

Use this INSTEAD OF blocking sleep loops (e.g. \`sleep 150 && echo done\` repeated). Examples: waiting for an SSM command to finish, a cross-region image to become available, a deployment/build to complete, or a service health check to pass.

How it works:
- \`checkCommand\` is executed repeatedly with backoff (interval grows ${DEFAULT_BACKOFF_MULTIPLIER}x up to a max).
- Success: when \`successWhen\` is "exit0", the command exiting 0 means done; otherwise \`successWhen\` is a regex matched against the command output.
- \`failWhen\` (optional regex) fast-fails the wait when matched. If both \`failWhen\` and \`successWhen\` match the same output, \`failWhen\` wins.
- \`maxWaitSeconds\` bounds the total wait (default ${DEFAULT_MAX_WAIT_SECONDS}s, capped at ${MAX_WAIT_CEILING_SECONDS}s).

Note: when a new message interrupts the turn, the wait returns promptly with outcome 'interrupted'. The check command that was in-flight at that moment is left running in the background (not killed), mirroring executeCommand's interruption behaviour.

IMPORTANT — choosing a wait mechanism:
- Very short waits (a few seconds): just run a single command with a higher \`timeoutMs\` on executeCommand.
- Minutes up to ~${Math.round(MAX_WAIT_CEILING_SECONDS / 60)} minutes: use this tool.
- Longer than that, or when cost/interrupt risk is a concern: do NOT hold the turn — use createEventTrigger (oneTimeSchedule or eventPattern) to release the turn and have the job's completion wake you. The whole turn is bounded by an unconditional wall-clock limit, so a wait that approaches it will get the turn killed; that is why the ceiling is kept conservative.

The result is JSON: { outcome: 'succeeded' | 'failed' | 'timeout' | 'interrupted', elapsedSeconds, checks, lastExitCode, lastStdout, lastStderr, message }.`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
