import { sendSystemMessage, updateInstanceStatus } from '@remote-swe-agents/agent-core/lib';
import { stopMyself, terminateMyself, getInstanceLifecycle } from './ec2';
import { randomBytes } from 'crypto';

let killTimer: NodeJS.Timeout | undefined = undefined;
let paused = false;

// You can use setKillTimer to kill the process after 15 minutes.
// If setKillTimer is called before 15 minutes elapsed, the timer count is reset and another
// 15 minutes is required to kill the process.
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
  if (killTimer) {
    clearTimeout(killTimer);
  }
  killTimer = setTimeout(
    async () => {
      let isSpot = false;
      try {
        await sendSystemMessage(workerId, 'Going to sleep mode. You can wake me up at any time.');
        try {
          isSpot = (await getInstanceLifecycle()) === 'spot';
        } catch {
          isSpot = true;
        }
        await updateInstanceStatus(workerId, isSpot ? 'terminated' : 'stopped');
      } catch (e) {
        console.error('Kill timer: error before stop:', e);
      } finally {
        try {
          if (isSpot) {
            await terminateMyself();
          } else {
            await stopMyself();
          }
        } catch (e) {
          console.error('Kill timer: stop/terminate failed:', e);
        }
      }
    },
    15 * 60 * 1000
  );
};

let restartToken = '';

export const pauseKillTimer = () => {
  restartToken = randomBytes(8).toString('hex');
  if (killTimer) {
    clearTimeout(killTimer);
    killTimer = undefined;
    paused = true;
  }
  return restartToken;
};

export const restartKillTimer = (workerId: string, token: string) => {
  if (token == restartToken) {
    paused = false;
    setKillTimer(workerId);
  }
};
