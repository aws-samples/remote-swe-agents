import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { sendMessageToSlack } from '../../lib/slack';
import { sendPushNotificationToUser, resolveNotificationAgentName } from '../../lib/push-notification';
import { incrementUnread } from '../../lib/unread';
import { getSession, updateSessionLastMessage } from '../../lib/sessions';
import { getCustomAgent } from '../../lib/custom-agent';
import { getPreferences } from '../../lib/preferences';
import { sendWebappEvent } from '../../lib/events';
import { sanitiseForDelivery } from '../../lib/placeholder-detection';
import { shouldSuppressUserDelivery, recordUserDelivery } from '../../lib/user-delivery-dedup';
import { notifyOtherParticipants } from '../../lib/session-participants';
import { withChildSessionGuard } from '../child-guard';

const inputSchema = z.object({
  message: z.string().min(1).describe('The message you want to send to the user.'),
});

const name = 'sendMessageToUser';

/**
 * LLM-facing feedback returned when the tool is invoked with a placeholder
 * or scaffolding artifact instead of a real message. Pinning the exact
 * wording keeps the regression tests addressable and gives the model a
 * clear enough hint to either call again with real content or end its
 * turn silently.
 */
const PLACEHOLDER_REJECTION_MESSAGE =
  "Your message was detected as a placeholder (empty / '.' / scaffolding artifact) and was NOT delivered to the user. " +
  'Please call sendMessageToUser again with meaningful content, OR end your turn silently if you have nothing new to report.';

export const sendMessageToUser = async (workerId: string, message: string) => {
  if (await shouldSuppressUserDelivery(workerId, message)) {
    console.warn(
      `[report-progress] Suppressing near-duplicate user delivery for ${workerId} ` +
        `(likely auto-retrigger re-emit; first 80 chars="${message.slice(0, 80).replace(/\s+/g, ' ')}")`
    );
    return;
  }

  await sendMessageToSlack(message);

  await recordUserDelivery(workerId, message);

  const lastMessagePreview = message.slice(0, 500);
  await updateSessionLastMessage(workerId, lastMessagePreview);
  await sendWebappEvent(workerId, {
    type: 'lastMessageUpdate',
    lastMessage: lastMessagePreview,
    lastMessageAt: Date.now(),
  });

  try {
    const session = await getSession(workerId);
    const customAgent = await getCustomAgent(session?.customAgentId);
    const prefs = await getPreferences();
    const agentDisplayName = resolveNotificationAgentName({
      customAgentId: session?.customAgentId,
      customAgentName: customAgent?.name,
      sessionAgentName: session?.agentName,
      defaultAgentName: prefs.defaultAgentName || undefined,
    });
    const sessionLabel = (session?.title || workerId).slice(0, 80);
    const title = agentDisplayName;
    const body = `${sessionLabel}\n${message.slice(0, 200)}`;

    if (session?.initiator?.startsWith('webapp#')) {
      const userId = session.initiator.replace('webapp#', '');

      await incrementUnread(userId, workerId);

      await sendPushNotificationToUser(userId, {
        title,
        body,
        url: `/sessions/${workerId}`,
        workerId,
      });

      await notifyOtherParticipants(workerId, userId, { title, body });
    } else {
      await notifyOtherParticipants(workerId, undefined, { title, body });
    }
  } catch (e) {
    console.error('[push] Failed to send push from sendMessageToUser:', e);
  }
};

const coreMessageHandler = async (
  input: z.infer<typeof inputSchema>,
  context: { workerId: string; toolUseId: string; globalPreferences: any; cancellationToken?: any }
): Promise<string> => {
  await sendMessageToUser(context.workerId, input.message);
  return 'Successfully sent a message.';
};

const guardedMessageHandler = withChildSessionGuard(coreMessageHandler, {
  pendingKey: 'user-message',
  confirmToolName: 'confirmSendToUser',
  serializePending: (input) => input.message,
  toolDisplayName: 'sendMessageToUser',
});

export const reportProgressTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const sanitised = sanitiseForDelivery(input.message);
    if (!sanitised.shouldSend) {
      return PLACEHOLDER_REJECTION_MESSAGE;
    }
    return guardedMessageHandler({ message: sanitised.message }, context);
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

export { PLACEHOLDER_REJECTION_MESSAGE };
