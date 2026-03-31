import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { getSession } from '../../lib/sessions';
import { createSession } from '../../lib/create-session';
import { getWebappSessionUrl } from '../../lib/webapp-origin';

const inputSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe('The initial message to send to the new session. This should clearly describe the task or topic.'),
  title: z.string().max(50).optional().describe('Optional title for the new session.'),
});

const name = 'createNewSession';

export const createNewSessionTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const currentSession = await getSession(context.workerId);
    if (!currentSession) {
      return 'Error: Could not retrieve current session information.';
    }

    const initiator = currentSession.initiator ?? 'tool';
    let slackMentionUserId: string | undefined;
    if (initiator.startsWith('slack#')) {
      slackMentionUserId = initiator.replace('slack#', '');
    }

    const workerId = await createSession({
      message: input.message,
      initiator,
      customAgentId: currentSession.customAgentId,
      title: input.title,
      slackChannelId: currentSession.slackChannelId,
      slackMentionUserId,
    });

    const sessionUrl = await getWebappSessionUrl(workerId);
    const urlInfo = sessionUrl ? `\n- Web UI: ${sessionUrl}` : '';
    const slackInfo = currentSession.slackChannelId
      ? '\n- Slack: A new thread has been created in the same channel'
      : '';

    return `New session created successfully.\n- Session ID: ${workerId}\n- Title: ${input.title ?? '(auto-generated)'}\n- Message: ${input.message}${urlInfo}${slackInfo}`;
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Create a new session with a separate agent to handle a divergent topic or task.

## When to use:
- When the conversation has shifted to a completely different topic that deserves its own session
- When the user asks you to handle a separate task that is unrelated to the current session's purpose
- When splitting work across sessions would improve organization and clarity

## IMPORTANT - Cost awareness:
- Creating a new session starts a new agent runtime, which incurs additional cost
- You SHOULD confirm with the user before creating a new session (e.g. "This seems like a separate topic. Shall I create a new session for it?")
- User confirmation is not technically required, but strongly recommended as a best practice

## Behavior:
- The new session inherits the current session's agent configuration (custom agent, runtime type, etc.)
- If the current session is linked to Slack, a new thread will be created in the same Slack channel
- The new session will start processing the message immediately after creation
- You will receive the new session ID in the response`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
