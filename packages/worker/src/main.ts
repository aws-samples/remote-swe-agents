import { Amplify } from 'aws-amplify';
import { events } from 'aws-amplify/data';
import { onMessageReceived, resume } from './agent';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import './common/signal-handler';
import { setKillTimer, pauseKillTimer, restartKillTimer } from './common/kill-timer';
import { CancellationToken } from './common/cancellation-token';
import { sendSystemMessage, updateInstanceStatus, workerEventSchema } from '@remote-swe-agents/agent-core/lib';
import { WorkerId } from '@remote-swe-agents/agent-core/env';
import { updateAgentStatusWithEvent } from './common/status';
import { refreshSession } from './common/refresh-session';

Object.assign(global, { WebSocket: require('ws') });

const workerId = WorkerId;
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
  private sessions: { isFinished: boolean; cancellationToken: CancellationToken }[] = [];
  public constructor(private readonly workerId: string) {}

  public startOnMessageReceived() {
    const session = { isFinished: false, cancellationToken: new CancellationToken() };
    this.sessions.push(session);
    // temporarily pause kill timer when an agent loop is running
    const restartToken = pauseKillTimer();
    onMessageReceived(this.workerId, session.cancellationToken)
      .then(() => {
        session.isFinished = true;
      })
      .catch((e) => {
        sendSystemMessage(workerId, `An error occurred: ${e}`).catch((e) => console.log(e));
        console.log(e);
      })
      .finally(() => {
        restartKillTimer(restartToken);
      });
  }

  public startResume() {
    const session = { isFinished: false, cancellationToken: new CancellationToken() };
    this.sessions.push(session);
    const restartToken = pauseKillTimer();
    resume(this.workerId, session.cancellationToken)
      .then(() => {
        session.isFinished = true;
      })
      .catch((e) => {
        sendSystemMessage(workerId, `An error occurred: ${e}`).catch((e) => console.log(e));
        console.log(e);
      })
      .finally(() => {
        restartKillTimer(restartToken);
      });
  }

  /**
   *
   * @param callback The callback function that is executed when each session is cancelled.
   */
  public cancelCurrentSessions(callback?: () => Promise<any>) {
    // cancel unfinished sessions
    for (const task of this.sessions) {
      if (task.isFinished) continue;
      task.cancellationToken.cancel(callback);
      console.log(`cancelled an ongoing converse session.`);
    }
    // remove finished sessions
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      if (this.sessions[i].isFinished) {
        this.sessions.splice(i, 1);
      }
    }
  }
}

const main = async () => {
  const tracker = new ConverseSessionTracker(workerId);
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
        tracker.cancelCurrentSessions();
        tracker.startOnMessageReceived();
      } else if (type == 'forceStop') {
        tracker.cancelCurrentSessions(async () => {
          // Update agent status to pending after force stop
          await updateAgentStatusWithEvent(workerId, 'pending');
          await sendSystemMessage(workerId, 'Agent work was stopped.');
        });
      } else if (type == 'sessionUpdated') {
        await refreshSession(workerId);
      }
    },
    error: (err) => console.log(err),
  });

  setKillTimer();

  try {
    // Update instance status to "running" in DynamoDB
    await updateInstanceStatus(workerId, 'running');

    await sendSystemMessage(workerId, 'the instance has successfully launched!');
    tracker.startResume();
  } catch (e) {
    await sendSystemMessage(workerId, `An error occurred: ${e}`);
    console.log(e);
  }
};

main();
