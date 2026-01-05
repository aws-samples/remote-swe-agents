import { WebClient } from '@slack/web-api';

type SlackThreadMessage = {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  files?: { name?: string; title?: string }[];
};

export type ThreadContextMessage = {
  text: string;
  slackUserId: string;
  ts: number;
};

const toTsNumber = (ts: string) => Number.parseFloat(ts);

const formatFiles = (files?: { name?: string; title?: string }[]) => {
  if (!files?.length) {
    return '';
  }

  const names = files.map((file) => file.title || file.name).filter(Boolean);
  if (names.length === 0) {
    return '';
  }

  return `attachments: ${names.join(', ')}`;
};

const formatThreadMessage = (message: SlackThreadMessage): ThreadContextMessage | undefined => {
  if (message.subtype && !['bot_message', 'thread_broadcast'].includes(message.subtype)) {
    return;
  }

  const text = message.text?.trim() ?? '';
  const attachments = formatFiles(message.files);
  if (!text && !attachments) {
    return;
  }

  const author = message.user ? `<@${message.user}>` : message.bot_id ? `bot:${message.bot_id}` : 'unknown';
  const body = [text, attachments].filter(Boolean).join('\n');

  return {
    text: `${author}: ${body}`,
    slackUserId: message.user ?? '',
    ts: toTsNumber(message.ts),
  };
};

const fetchThreadMessages = async (client: WebClient, channel: string, threadTs: string) => {
  const messages: SlackThreadMessage[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.conversations.replies({
      channel,
      ts: threadTs,
      cursor,
      limit: 200,
    });

    messages.push(...((response.messages ?? []) as SlackThreadMessage[]));
    const nextCursor = response.response_metadata?.next_cursor;
    cursor = nextCursor && nextCursor.length > 0 ? nextCursor : undefined;
  } while (cursor);

  return messages;
};

export const fetchThreadContextMessages = async (
  client: WebClient,
  channel: string,
  threadTs: string,
  currentTs: string
): Promise<ThreadContextMessage[]> => {
  const currentTsNumber = toTsNumber(currentTs);
  const messages = await fetchThreadMessages(client, channel, threadTs);

  return messages
    .map(formatThreadMessage)
    .filter((message): message is ThreadContextMessage => Boolean(message))
    .filter((message) => message.ts < currentTsNumber)
    .sort((left, right) => left.ts - right.ts);
};
