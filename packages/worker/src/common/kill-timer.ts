import { sendSystemMessage, updateInstanceStatus } from '@remote-swe-agents/agent-core/lib';
import { stopMyself } from './ec2';
import { notifyTermination } from './notify-termination';
import { randomBytes } from 'crypto';
import { getProcessRuntimeType } from '../runtime-type';

let killTimer: NodeJS.Timeout | undefined = undefined;
let paused = false;

// You can use setKillTimer to kill the process after 30 minutes.
// If setKillTimer is called before 30 minutes elapsed, the timer count is reset and another
// 30 minutes is required to kill the process.
//
// On agent-core runtime, the initial kill timer on startup is skipped. The timer only
// starts when the agent transitions from working to waiting-for-user (via restartKillTimer).
// This ensures agent-core sessions are never killed during active work, while still
// cleaning up sessions that have been idle for 30 minutes after completing a task.
//
// You can pause the timer to avoid process termination when a long-running process is executed
// outside of the control loop (e.g. agent's tool use).
// To avoid race condition, a restart token is issued when you call pauseKillTimer, and the current
// restart token is replaced every time pauseKillTimer is called. The restart token
// is required to match with the latest restart token when you call restartKillTimer.

// This mechanism prevents the following race condition:
// A: call pauseKillTimer
// B: call pauseKillTimer
// A: call restartKillTimer
//  -> process can be killed despite pause request from B.

export const setKillTimer = (workerId: string) => {
  if (paused) return;
  // On agent-core, skip the initial timer set on startup.
  // The timer will be started by restartKillTimer when the agent becomes idle.
  if (getProcessRuntimeType() === 'agent-core' && !hasWorkedBefore) return;
  if (killTimer) {
    clearTimeout(killTimer);
  }
  const timerArmedAt = Date.now();
  killTimer = setTimeout(
    async () => {
      const elapsedMin = ((Date.now() - timerArmedAt) / 60_000).toFixed(1);
      console.log(
        `[kill-timer] Firing for workerId=${workerId} after ${elapsedMin}min (armed at ${new Date(timerArmedAt).toISOString()})`
      );
      await sendSystemMessage(workerId, 'Going to sleep mode. You can wake me up at any time.');
      await notifyTermination(workerId, 'sleeping', '');
      // Update instance status to stopped in DynamoDB before stopping the instance
      await updateInstanceStatus(workerId, 'stopped');
      await stopMyself(workerId);
    },
    30 * 60 * 1000
  );
};

let restartToken = '';
let hasWorkedBefore = false;

export const pauseKillTimer = () => {
  restartToken = randomBytes(8).toString('hex');
  if (killTimer) {
    clearTimeout(killTimer);
    killTimer = undefined;
    paused = true;
  }
  hasWorkedBefore = true;
  return restartToken;
};

export const restartKillTimer = (workerId: string, token: string) => {
  if (token == restartToken) {
    paused = false;
    setKillTimer(workerId);
  }
};
