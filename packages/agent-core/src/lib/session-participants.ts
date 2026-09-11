import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { sendPushNotificationToUser } from './push-notification';
import { incrementUnread } from './unread';

/**
 * Record a webapp user as a participant of a session.
 * Uses a conditional write to avoid unnecessary overwrites.
 */
export async function addSessionParticipant(workerId: string, userId: string): Promise<void> {
  try {
    await ddb.send(
      new PutCommand({
        TableName,
        Item: {
          PK: `session-participants-${workerId}`,
          SK: userId,
          joinedAt: Date.now(),
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      })
    );
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      // Already a participant, no-op
      return;
    }
    throw error;
  }
}

/**
 * Get all participant user IDs for a session.
 */
export async function getSessionParticipants(workerId: string): Promise<string[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `session-participants-${workerId}`,
      },
      ProjectionExpression: 'SK',
    })
  );
  return (result.Items ?? []).map((item) => item.SK as string);
}

/**
 * Notify all session participants (except the sender) about a new user message.
 * Sends push notification and increments unread count for each recipient.
 *
 * @param workerId - Session ID
 * @param senderUserId - The user who posted the message (excluded from notifications). May be undefined for Slack/API key senders.
 * @param payload - Notification content
 */
export async function notifyOtherParticipants(
  workerId: string,
  senderUserId: string | undefined,
  payload: { title: string; body: string; icon?: string }
): Promise<void> {
  const participants = await getSessionParticipants(workerId);

  const recipients = participants.filter((userId) => userId !== senderUserId);
  if (recipients.length === 0) return;

  const url = `/sessions/${workerId}`;

  await Promise.all(
    recipients.map(async (userId) => {
      try {
        await incrementUnread(userId, workerId);
        await sendPushNotificationToUser(userId, {
          title: payload.title,
          body: payload.body,
          url,
          workerId,
          ...(payload.icon ? { icon: payload.icon } : {}),
        });
      } catch (e) {
        console.error(`[session-participants] Failed to notify user ${userId} for session ${workerId}:`, e);
      }
    })
  );
}

/**
 * Copy all participants from one session to another.
 * Used during session handover (successor) to preserve notification continuity.
 */
export async function copySessionParticipants(sourceWorkerId: string, targetWorkerId: string): Promise<void> {
  const participants = await getSessionParticipants(sourceWorkerId);
  await Promise.all(participants.map((userId) => addSessionParticipant(targetWorkerId, userId)));
}
