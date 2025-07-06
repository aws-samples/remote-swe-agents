import { WebClient } from '@slack/web-api';
import { ApproveUsers } from '../util/auth';
import { ValidationError } from '../util/error';

export async function handleApproveUser(
  event: {
    text: string;
    user?: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    blocks?: any[];
  },
  client: WebClient
): Promise<void> {
  const userId = event.user ?? '';
  const channel = event.channel;

  const block = event.blocks?.[0];
  if (block != null && 'elements' in block) {
    const element = block.elements[0];
    if (element.type == 'rich_text_section') {
      const users = element.elements
        .slice(1)
        .filter((elem: any) => elem.type == 'user')
        .map((elem: any) => elem.user_id);
      if (users.length >= 25) {
        throw new ValidationError('too many users.');
      }
      if (users.length == 0) {
        throw new ValidationError('no user is specified.');
      }
      await ApproveUsers(users, channel);
      await client.chat.postMessage({
        channel,
        thread_ts: event.thread_ts ?? event.ts,
        text: `<@${userId}> Successfully approved ${users.length} user(s) in this channel!`,
      });
      return;
    }
  }
  throw new ValidationError('Usage: @remote-swe approve_user @user1 @user2');
}
