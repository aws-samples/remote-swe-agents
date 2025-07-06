import { getConversationHistory, getSession, sendWorkerEvent } from '@remote-swe-agents/agent-core/lib';
import { WebClient } from '@slack/web-api';
import { SessionMap } from '../util/session-map';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { TransactWriteCommand, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ValidationError } from '../util/error';

export async function handleTakeOver(
  event: {
    text: string;
    user?: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    blocks?: any[];
    files?: any[];
  },
  client: WebClient
): Promise<void> {
  if (event.thread_ts) {
    throw new ValidationError('You can only take over a session from a new Slack thread.');
  }

  const message = event.text
    .replace(/<@[A-Z0-9]+>\s*/g, '')
    .replace(/[<>]/g, '')
    .trim();

  const match = message.match(/take_over\s+(https?:\/\/[^\s]+\/sessions\/([^\s\/]+))/);
  if (!match) {
    throw new ValidationError('Invalid format. Expected: take_over <session URL>');
  }

  const sessionUrl = match[1];
  const sessionId = match[2];

  console.log('Session URL:', sessionUrl);
  console.log('Session ID:', sessionId);

  const session = await getSession(sessionId);
  if (!session) {
    throw new ValidationError(`No session was found for ${sessionId}`);
  }

  if (session.slackChannelId && session.slackThreadTs) {
    throw new ValidationError(`This session already belongs to other Slack thread.`);
  }

  await takeOverSessionToSlack(sessionId, event.channel, event.ts, event.user ?? '');
  await sendWorkerEvent(sessionId, { type: 'sessionUpdated' });

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: `<@${event.user}> Successfully took over the session ${sessionId}.`,
  });
}

const takeOverSessionToSlack = async (
  workerId: string,
  slackChannelId: string,
  slackThreadTs: string,
  slackUserId: string
) => {
  const { items } = await getConversationHistory(workerId);
  const lastUserMessage = items.findLast((i) => i.messageType == 'userMessage');

  const transactItems: TransactWriteCommandInput['TransactItems'] = [
    {
      Put: {
        TableName,
        Item: {
          PK: 'session-map',
          SK: `slack-${slackChannelId}-${slackThreadTs}`,
          sessionId: workerId,
        } satisfies SessionMap,
      },
    },
    {
      Update: {
        TableName,
        Key: {
          PK: 'sessions',
          SK: workerId,
        },
        UpdateExpression: 'SET slackChannelId = :slackChannelId, slackThreadTs = :slackThreadTs',
        ExpressionAttributeValues: {
          ':slackChannelId': slackChannelId,
          ':slackThreadTs': slackThreadTs,
        },
      },
    },
  ];

  if (lastUserMessage) {
    transactItems.push({
      Update: {
        TableName,
        Key: {
          PK: lastUserMessage.PK,
          SK: lastUserMessage.SK,
        },
        UpdateExpression: 'SET slackUserId = :slackUserId',
        ExpressionAttributeValues: {
          ':slackUserId': slackUserId,
        },
      },
    });
  }

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: transactItems,
    })
  );
};
