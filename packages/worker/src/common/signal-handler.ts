import { closeMcpServers } from '../agent/mcp';
import { disposeAllBackends } from '../agent/backends';
import { getSession, sendSystemMessage, saveConversationHistory } from '@remote-swe-agents/agent-core/lib';
import { notifyTermination } from './notify-termination';
import { updateAgentStatusWithEvent } from './status';

// The workerId this process is serving, captured at startup by entry.main().
// Falls back to the EC2 env var. Used to notify the parent if the process is
// terminated (deploy SIGTERM / agent-core eviction) while a turn is running.
let activeWorkerId: string | undefined = process.env.WORKER_ID;
export const setActiveWorkerId = (workerId: string) => {
  activeWorkerId = workerId;
};

// Callback to cancel active CancellationTokens held by ConverseSessionTracker.
// Set by entry.ts after the tracker is created. Called during SIGTERM to signal
// backends (kiro-cli) to stop immediately — prevents process-died recovery from
// re-spawning and sending duplicate "An error occurred" messages.
let cancelActiveTokensFn: (() => void) | undefined;
export const setCancelActiveTokens = (fn: () => void) => {
  cancelActiveTokensFn = fn;
};

// Notify the parent if the process is terminated while a turn is in progress
// (agentStatus === 'working') — the child died mid-task, so wake the parent.
// Idle/slept sessions are skipped: the kill timer already emits [Child sleeping]
// before stopMyself triggers this signal, so notifying here would be a false
// [Child error]. Known gap: SIGKILL / OOM cannot be trapped (no JS runs), so the
// parent is not notified in those cases — out of scope here (needs a watchdog).
// Exported for unit testing.
export const notifyTerminationIfActiveTurn = async (signal: string): Promise<void> => {
  if (!activeWorkerId) return;
  try {
    const session = await getSession(activeWorkerId);
    if (session?.agentStatus !== 'working') return;
  } catch (e) {
    console.error('[signal-handler] getSession failed during termination notify:', e);
    return;
  }
  // Each step is individually error-isolated so a failure in one (e.g.
  // sendSystemMessage DDB throttle) does not prevent the others from running.
  const feedbackText = 'Agent work was stopped.';
  let feedbackSK: string | undefined;
  try {
    const saved = await saveConversationHistory(
      activeWorkerId,
      { role: 'assistant', content: [{ text: feedbackText }] },
      0,
      'assistant'
    );
    feedbackSK = saved.SK;
  } catch (e) {
    console.error('[signal-handler] persist feedback to DDB failed:', e);
  }
  try {
    await sendSystemMessage(activeWorkerId, feedbackText, false, false, feedbackSK);
  } catch (e) {
    console.error('[signal-handler] sendSystemMessage failed:', e);
  }
  try {
    await updateAgentStatusWithEvent(activeWorkerId, 'pending');
  } catch (e) {
    console.error('[signal-handler] updateAgentStatusWithEvent failed:', e);
  }
  try {
    await notifyTermination(
      activeWorkerId,
      'error',
      `Worker process received ${signal} while a turn was in progress (runtime shutdown / eviction). The turn did not complete.`
    );
  } catch (e) {
    console.error('[signal-handler] notifyTermination failed:', e);
  }
};

const exit = async (signal: string) => {
  console.log(`${signal} received. Now shutting down ... please wait`);
  // Establish the hard 10s upper bound FIRST so a DDB stall in the termination
  // notify or backend teardown can never exceed it. The forced path is reserved
  // for genuinely stuck shutdowns (kiro-cli SIGKILL fallback exhausted,
  // dangling MCP HTTP connections, slow DynamoDB, etc.).
  const forceExitTimer = setTimeout(() => {
    console.warn('[signal-handler] graceful shutdown exceeded 10s; forcing process.exit(0)');
    process.exit(0);
  }, 10000);
  // Cancel active CancellationTokens BEFORE the backend dispose so that:
  // 1. kiro-cli backends see cancellation and do not attempt process-died
  //  recovery (which would re-spawn & send duplicate "An error occurred").
  // 2. The orchestrator loop exits cleanly without racing the subprocess death.
  if (cancelActiveTokensFn) {
    try {
      cancelActiveTokensFn();
    } catch (e) {
      console.error('[signal-handler] cancelActiveTokens error:', e);
    }
  }
  await notifyTerminationIfActiveTurn(signal);
  // Tear down every backend (Kiro singleton ACP subprocess, future
  // backends). disposeAllBackends() is awaited so the kiro-cli subprocess
  // OS-level `'exit'` is observed before we move on to the MCP/port
  // cleanup; otherwise an in-flight session-lock release could race the
  // next worker boot.
  //
  // The backend dispose and the MCP/port cleanup are kept in *separate*
  // try blocks: a failure in disposeAllBackends() (e.g. a kiro-cli
  // subprocess that refused both SIGTERM and SIGKILL within its 5s
  // budget and surfaces the rejection) must NOT cause the MCP HTTP
  // server and port cleanup to be skipped — those resources are
  // independent and would otherwise leak across the worker restart.
  try {
    await disposeAllBackends();
  } catch (e) {
    console.error('[signal-handler] disposeAllBackends error:', e);
  }
  await Promise.allSettled([closeMcpServers()]);
  clearTimeout(forceExitTimer);
  process.exit(0);
};

process.on('SIGHUP', () => {
  exit('SIGHUP');
});

process.on('SIGINT', () => {
  exit('SIGINT');
});

process.on('SIGTERM', () => {
  exit('SIGTERM');
});

console.log(`[signal-handler] registered (pid=${process.pid}, ppid=${process.ppid})`);
