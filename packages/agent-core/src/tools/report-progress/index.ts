import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { sendMessageToSlack } from '../../lib/slack';
import { sendPushNotificationToUser } from '../../lib/push-notification';
import { incrementUnread } from '../../lib/unread';
import { getSession, updateSessionLastMessage } from '../../lib/sessions';
import { sendWebappEvent } from '../../lib/events';
import { getConversationHistory } from '../../lib/messages';
import { savePendingUserMessage } from '../confirm-send-to-user';

const inputSchema = z.object({
  message: z.string().describe('The message you want to send to the user.'),
});

const name = 'sendMessageToUser';

export const sendMessageToUser = async (workerId: string, message: string) => {
  await sendMessageToSlack(message);

  const lastMessagePreview = message.slice(0, 500);
  await updateSessionLastMessage(workerId, lastMessagePreview);
  await sendWebappEvent(workerId, {
    type: 'lastMessageUpdate',
    lastMessage: lastMessagePreview,
    lastMessageAt: Date.now(),
  });

  // Send push notification
  try {
    const session = await getSession(workerId);
    if (session?.initiator?.startsWith('webapp#')) {
      const userId = session.initiator.replace('webapp#', '');
      const title = session.title || 'Agent Message';

      await incrementUnread(userId, workerId);

      await sendPushNotificationToUser(userId, {
        title,
        body: message.slice(0, 200),
        url: `/sessions/${workerId}`,
        workerId,
      });
    }
  } catch (e) {
    console.error('[push] Failed to send push from sendMessageToUser:', e);
  }
};

export const reportProgressTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const session = await getSession(context.workerId);

    // Child session confirmation check
    if (session?.parentSessionId) {
      const { items } = await getConversationHistory(context.workerId);
      // Skip toolUse/toolResult/assistant/errorFeedback to find the actual triggering message.
      // The last item is typically toolUse (saved before handler runs), so we need to look past it.
      const triggeringItem = items.findLast(
        (i) => !['toolUse', 'toolResult', 'assistant', 'errorFeedback'].includes(i.messageType)
      );
      const triggeringMessageType = triggeringItem?.messageType ?? 'unknown';

      if (triggeringMessageType !== 'userMessage') {
        const userMessageCount = items.filter((i) => i.messageType === 'userMessage').length;
        const senderInfo = triggeringItem?.senderAgentName ?? triggeringItem?.senderSessionId ?? 'system';

        // Case 1: No user messages at all - the user never interacted with this session directly.
        // Block completely without allowing confirmSendToUser.
        if (userMessageCount === 0) {
          return [
            `ERROR: sendMessageToUser is not available in this child session.`,
            `The user has never sent a message to this session directly (0 user messages), which means they do not expect to receive messages from here.`,
            ``,
            `You MUST use sendMessageToAgent to report to your parent session instead.`,
            `Do NOT call confirmSendToUser — it will not work for this case.`,
          ].join('\n');
        }

        // Case 2: User has interacted before, but the most recent triggering message is not from the user.
        // Allow with strong warning + confirmSendToUser.
        savePendingUserMessage(context.workerId, input.message);

        return [
          `WARNING: You are almost certainly making a mistake. There is a 99% chance you should NOT send this message directly to the user.`,
          ``,
          `This is a child session and the last triggering message is NOT from the user:`,
          `- Messages from user in this session: ${userMessageCount}`,
          `- Last message is from: ${triggeringMessageType} (${senderInfo})`,
          ``,
          `The only scenario where sending directly to the user is appropriate is when the user previously asked you to investigate something directly in this session and you are reporting back after a long delay.`,
          ``,
          `In almost all cases, you should use sendMessageToAgent to report to your parent session instead.`,
          `If you are ABSOLUTELY CERTAIN this is one of the rare exceptions, call confirmSendToUser to proceed.`,
        ].join('\n');
      }
    }

    await sendMessageToUser(context.workerId, input.message);
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
