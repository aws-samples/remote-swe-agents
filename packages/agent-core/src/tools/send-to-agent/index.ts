import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { sendAgentMessage } from '../../lib/agent-messaging';

const inputSchema = z.object({
  targetSessionIds: z.array(z.string()).min(1).describe('One or more session IDs to send the message to.'),
  message: z.string().min(1).describe('The message to send to the target agent(s).'),
});

const name = 'sendMessageToAgent';

export const sendToAgentTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const result = await sendAgentMessage({
      senderWorkerId: context.workerId,
      targetSessionIds: input.targetSessionIds,
      message: input.message,
    });

    const lines: string[] = [];
    if (result.sent.length > 0) {
      lines.push(`Successfully sent message to: ${result.sent.join(', ')}`);
    }
    for (const f of result.failed) {
      lines.push(`Failed to send to ${f.sessionId}: ${f.reason}`);
    }
    return lines.join('\n') || 'No messages sent.';
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Send a message to one or more agent sessions. Use this for agent-to-agent communication.
The target agent(s) will receive the message and be woken up to process it.
The user will NOT be notified directly — use sendMessageToUser for user-facing messages.

You can find session IDs of your parent/siblings from the session hierarchy information in your system prompt,
or from the response of createNewSession when you create child sessions.`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
