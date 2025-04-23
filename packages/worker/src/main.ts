import { Amplify } from 'aws-amplify';
import { events } from 'aws-amplify/data';
import { onMessageReceived, resume } from './agent';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { WorkerId } from './common/constants';
import './common/signal-handler';
import { sendMessageToSlack, setKillTimer } from '@remote-swe-agents/agent-core/lib';
import { CancellationToken } from './common/cancellation-token';

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
    onMessageReceived(this.workerId, session.cancellationToken)
      .then(() => {
        session.isFinished = true;
      })
      .catch((e) => {
        sendMessageToSlack(`An error occurred: ${e}`).catch((e) => console.log(e));
      });
  }

  public startResume() {
    const session = { isFinished: false, cancellationToken: new CancellationToken() };
    this.sessions.push(session);
    resume(this.workerId, session.cancellationToken)
      .then(() => {
        session.isFinished = true;
      })
      .catch((e) => {
        sendMessageToSlack(`An error occurred: ${e}`).catch((e) => console.log(e));
      });
  }

  public cancelCurrentSessions() {
    // cancel unfinished sessions
    for (const task of this.sessions) {
      if (task.isFinished) continue;
      task.cancellationToken.cancel();
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
    error: (err) => console.error('error', err),
  });

  const unicast = await events.connect(`/event-bus/${workerId}`);
  unicast.subscribe({
    next: async (data) => {
      setKillTimer();
      const type = data.event?.type;
      if (type == 'onMessageReceived') {
        tracker.cancelCurrentSessions();
        tracker.startOnMessageReceived();
      }
    },
    error: (err) => console.error('error', err),
  });

  setKillTimer();

  try {
    await sendMessageToSlack('the instance has successfully launched!');
    tracker.startResume();
  } catch (e) {
    await sendMessageToSlack(`An error occurred: ${e}`);
  }
};

main();
