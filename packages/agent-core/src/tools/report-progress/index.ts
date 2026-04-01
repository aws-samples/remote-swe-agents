import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { sendMessageToSlack } from '../../lib/slack';
import { sendPushNotificationToUser } from '../../lib/push-notification';
import { incrementUnread } from '../../lib/unread';
import { getSession, updateSessionLastMessage } from '../../lib/sessions';
import { sendWebappEvent } from '../../lib/events';

const inputSchema = z.object({
  message: z.string().describe('The message you want to send to the user.'),
});

const name = 'sendMessageToUser';

export const reportProgressTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    await sendMessageToSlack(input.message);

    const lastMessagePreview = input.message.slice(0, 500);
    await updateSessionLastMessage(context.workerId, lastMessagePreview);
    await sendWebappEvent(context.workerId, {
      type: 'lastMessageUpdate',
      lastMessage: lastMessagePreview,
      lastMessageAt: Date.now(),
    });

    // Send push notification
    try {
      const session = await getSession(context.workerId);
      if (session?.initiator?.startsWith('webapp#')) {
        const userId = session.initiator.replace('webapp#', '');
        const title = session.title || 'Agent Message';

        await incrementUnread(userId, context.workerId);

        await sendPushNotificationToUser(userId, {
          title,
          body: input.message.slice(0, 200),
          url: `/sessions/${context.workerId}`,
          workerId: context.workerId,
        });
      }
    } catch (e) {
      console.error('[push] Failed to send push from sendMessageToUser:', e);
    }

    return 'Successfully sent a message.';
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `
Send any message to the user. This is especially valuable if the message contains any information the user want to know, such as how you are solving the problem now. Without this tool, a user cannot know your progress because message is only sent when you finished using tools and end your turn.
    `.trim(),
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
