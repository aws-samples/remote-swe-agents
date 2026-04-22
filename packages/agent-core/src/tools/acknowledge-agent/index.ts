import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { sendAgentMessage } from '../../lib/agent-messaging';

const inputSchema = z.object({
  targetSessionIds: z.array(z.string()).min(1).describe('One or more session IDs to acknowledge.'),
  message: z
    .string()
    .min(1)
    .describe(
      'A short acknowledgement message (e.g. "Got it, working on it." or "Task complete, here are the results: ...").'
    ),
});

const name = 'acknowledgeAgent';

export const acknowledgeAgentTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const result = await sendAgentMessage({
      senderWorkerId: context.workerId,
      targetSessionIds: input.targetSessionIds,
      message: input.message,
      acknowledge: true,
    });

    const lines: string[] = [];
    if (result.sent.length > 0) {
      lines.push(`Acknowledged to: ${result.sent.join(', ')} (message saved, agent NOT woken up)`);
    }
    for (const f of result.failed) {
      lines.push(`Failed to acknowledge ${f.sessionId}: ${f.reason}`);
    }
    return lines.join('\n') || 'No acknowledgements sent.';
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Send an acknowledgement message to another agent session WITHOUT waking up the target agent.
The message is saved in the target's conversation history but does NOT trigger a new agent turn.
This is like a Slack reaction — the target will see it next time they wake up, but won't be interrupted.

Use this instead of sendMessageToAgent when:
- You want to confirm receipt without triggering a response loop
- The conversation has reached a natural stopping point
- You're providing a final status update that doesn't need immediate action`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
