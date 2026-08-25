import { Amplify } from 'aws-amplify';
import { events } from 'aws-amplify/data';
import { onMessageReceived, resume } from './agent';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { setActiveWorkerId, setCancelActiveTokens } from './common/signal-handler';
import { setKillTimer, pauseKillTimer, restartKillTimer } from './common/kill-timer';
import { CancellationToken } from './common/cancellation-token';
import {
  sendSystemMessage,
  saveConversationHistory,
  updateInstanceStatus,
  workerEventSchema,
} from '@remote-swe-agents/agent-core/lib';
import { updateAgentStatusWithEvent } from './common/status';
import { refreshSession } from './common/refresh-session';
import { notifyTermination } from './common/notify-termination';

Object.assign(global, { WebSocket: require('ws') });

const notifyOwnerOnError = async (workerId: string, error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  await notifyTermination(workerId, 'error', msg);
};

const eventHttpEndpoint = process.env.EVENT_HTTP_ENDPOINT!;
const awsRegion = process.env.AWS_REGION!;

Amplify.configure(
  {
    API: {
      Events: {
        endpoint: `${eventHttpEndpoint}/event`,
        region: awsRegion,
        defaultAuthMode: 'iam',
      },
    },
  },
  {
    Auth: {
      credentialsProvider: {
        getCredentialsAndIdentityId: async () => {
          const provider = fromNodeProviderChain();
          const credentials = await provider();
          return {
            credentials,
          };
        },
        clearCredentialsAndIdentityId: async () => {},
      },
    },
  }
);

class ConverseSessionTracker {
  private sessions: { promise: Promise<void>; isFinished: boolean; cancellationToken: CancellationToken }[] = [];
  private operationQueue: Promise<void> = Promise.resolve();
  public constructor(private readonly workerId: string) {}

  private enqueue(operation: () => Promise<void>): void {
    this.operationQueue = this.operationQueue.then(operation).catch((e) => {
      console.log('Operation queue error:', e);
    });
  }

  public startOnMessageReceived() {
    this.enqueue(async () => {
      await this.cancelCurrentSessions();
      this._startOnMessageReceived();
    });
  }

  public startResume() {
    this.enqueue(async () => {
      await this.cancelCurrentSessions();
      this._startResume();
    });
  }

  public forceStop(callback?: () => Promise<any>) {
    this.enqueue(async () => {
      await this.cancelCurrentSessions(callback);
    });
  }

  private _startOnMessageReceived() {
    const session = { promise: Promise.resolve(), isFinished: false, cancellationToken: new CancellationToken() };
    this.sessions.push(session);
    // temporarily pause kill timer when an agent loop is running
    const restartToken = pauseKillTimer();
    session.promise = onMessageReceived(this.workerId, session.cancellationToken)
      .catch(async (e) => {
        const errorText = `An error occurred: ${e}`;
        console.log(e);
        // Safety net: reset agentStatus to 'pending' if onMessageReceived
        // rejects (e.g. its own finally block threw a DDB error before the
        // status update could complete). Without this, the session stays
        // stuck in 'working' permanently.
        updateAgentStatusWithEvent(this.workerId, 'pending').catch((statusErr) => {
          console.error('[entry] safety-net agentStatus reset failed:', statusErr);
        });
        try {
          const saved = await saveConversationHistory(
            this.workerId,
            { role: 'assistant', content: [{ text: errorText }] },
            0,
            'assistant'
          );
          await sendSystemMessage(this.workerId, errorText, false, false, saved.SK);
        } catch (sendErr) {
          console.log(sendErr);
        }
        notifyOwnerOnError(this.workerId, e).catch(() => {});
      })
      .finally(() => {
        session.isFinished = true;
        restartKillTimer(this.workerId, restartToken);
      });
  }

  private _startResume() {
    const session = { promise: Promise.resolve(), isFinished: false, cancellationToken: new CancellationToken() };
    this.sessions.push(session);
    const restartToken = pauseKillTimer();
    session.promise = resume(this.workerId, session.cancellationToken)
      .catch(async (e) => {
        const errorText = `An error occurred: ${e}`;
        console.log(e);
        // Safety net: reset agentStatus to 'pending' if resume rejects.
        updateAgentStatusWithEvent(this.workerId, 'pending').catch((statusErr) => {
          console.error('[entry] safety-net agentStatus reset failed:', statusErr);
        });
        try {
          const saved = await saveConversationHistory(
            this.workerId,
            { role: 'assistant', content: [{ text: errorText }] },
            0,
            'assistant'
          );
          await sendSystemMessage(this.workerId, errorText, false, false, saved.SK);
        } catch (sendErr) {
          console.log(sendErr);
        }
        notifyOwnerOnError(this.workerId, e).catch(() => {});
      })
      .finally(() => {
        session.isFinished = true;
        restartKillTimer(this.workerId, restartToken);
      });
  }

  /**
   *
   * @param callback The callback function that is executed when each session is cancelled.
   */
  private async cancelCurrentSessions(callback?: () => Promise<any>) {
    const runningPromises: Promise<void>[] = [];
    // cancel unfinished sessions
    for (const task of this.sessions) {
      if (task.isFinished) continue;
      task.cancellationToken.cancel(callback);
      runningPromises.push(task.promise);
      console.log(`cancelled an ongoing converse session.`);
    }
    // await all running loops to fully stop before returning, with a safety
    // timeout to prevent permanent deadlock if a backend fails to honour
    // cancellation (e.g. kiro-cli subprocess ignoring SIGKILL).
    let timedOut = false;
    if (runningPromises.length > 0) {
      console.log(`Awaiting ${runningPromises.length} running session(s) to complete...`);
      let timeoutId: NodeJS.Timeout;
      const timeout = new Promise<'timeout'>((resolve) => {
        timeoutId = setTimeout(() => {
          console.warn(
            `[ConverseSessionTracker] Safety timeout (30s) reached waiting for cancelled sessions. Proceeding.`
          );
          resolve('timeout');
        }, 30_000);
      });
      const settled = await Promise.race([Promise.allSettled(runningPromises).then(() => 'settled' as const), timeout]);
      clearTimeout(timeoutId!);
      timedOut = settled === 'timeout';
      console.log(`All sessions settled (or timed out).`);
    }
    // Remove finished sessions. If we hit the safety timeout we additionally
    // force-evict every still-running session here. Without this, hung
    // sessions linger in `this.sessions`, and the next `cancelCurrentSessions`
    // call would re-cancel an already-cancelled token (no listener fire,
    // since `_isCancelled` is already true and the listener array was drained
    // on first cancel) and once again wait for the full 30s timeout —
    // permanently degrading every subsequent message in this worker.
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      if (this.sessions[i]!.isFinished || timedOut) {
        this.sessions.splice(i, 1);
      }
    }
    if (timedOut) {
      console.warn(`[ConverseSessionTracker] Force-evicted ${runningPromises.length} hung session(s) after timeout.`);
    }
  }

  /**
   * return true if there is ongoing session.
   */
  public isBusy() {
    return this.sessions.some((session) => !session.isFinished);
  }

  /**
   * Cancel all active CancellationTokens without a completion callback.
   * Used by the signal handler to signal backends (kiro-cli) to stop
   * immediately during SIGTERM, preventing process-died recovery from
   * re-spawning and sending duplicate error messages.
   * Unlike forceStop(), this does NOT await session completion — it is
   * fire-and-forget, suitable for the tight SIGTERM shutdown window.
   */
  public cancelAllTokens() {
    for (const task of this.sessions) {
      if (!task.isFinished && !task.cancellationToken.isCancelled) {
        task.cancellationToken.cancel();
      }
    }
  }
}

const isStarted: { [key: string]: boolean } = {};
export const main = async (workerId: string) => {
  // Immediately pause any residual kill timer from a previous session on this
  // container (agent-core reuse / stop→resume re-invocation). Placed before the
  // isStarted guard so that re-invocations of an already-started worker (the
  // stop→resume path in agent-core.ts) also clear any armed timer.
  pauseKillTimer();

  if (isStarted[workerId]) {
    console.log(`The worker ${workerId} is already started.`);
    return;
  }

  isStarted[workerId] = true;
  setActiveWorkerId(workerId);
  const tracker = new ConverseSessionTracker(workerId);
  setCancelActiveTokens(() => tracker.cancelAllTokens());

  const broadcast = await events.connect('/event-bus/broadcast');
  broadcast.subscribe({
    next: (data) => {
      console.log('received broadcast', data);
    },
    error: (err) => console.log(err),
  });

  const unicast = await events.connect(`/event-bus/worker/${workerId}`);
  unicast.subscribe({
    next: async (data) => {
      const { data: event, error, success } = workerEventSchema.safeParse(data.event);
      if (!success || error) {
        console.log(`The worker event does not conform to the schema. Ignoring... ${JSON.stringify(data)}`);
        console.log(error);
        return;
      }
      const type = event.type;
      if (type == 'onMessageReceived') {
        tracker.startOnMessageReceived();
      } else if (type == 'forceStop') {
        tracker.forceStop(async () => {
          // Update agent status to pending after force stop
          await updateAgentStatusWithEvent(workerId, 'pending');
          const feedbackText = 'Agent work was stopped.';
          const saved = await saveConversationHistory(
            workerId,
            { role: 'assistant', content: [{ text: feedbackText }] },
            0,
            'assistant'
          );
          await sendSystemMessage(workerId, feedbackText, false, false, saved.SK);
        });
      } else if (type == 'sessionUpdated') {
        await refreshSession(workerId);
      }
    },
    error: (err) => console.log(err),
  });

  setKillTimer(workerId);

  try {
    // Update instance status to "running" in DynamoDB
    await updateInstanceStatus(workerId, 'running');

    tracker.startResume();
  } catch (e) {
    const errorText = `An error occurred: ${e}`;
    console.log(e);
    try {
      const saved = await saveConversationHistory(
        workerId,
        { role: 'assistant', content: [{ text: errorText }] },
        0,
        'assistant'
      );
      await sendSystemMessage(workerId, errorText, false, false, saved.SK);
    } catch (sendErr) {
      console.log(sendErr);
    }
    await notifyOwnerOnError(workerId, e);
  }

  return tracker;
};
