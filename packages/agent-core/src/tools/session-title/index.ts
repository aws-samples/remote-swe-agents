import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { updateSessionTitle } from '../../lib/sessions';
import { sendWebappEvent } from '../../lib/events';

const inputSchema = z.object({
  title: z
    .string()
    .max(50)
    .describe(
      'A concise title for the current session. Should be descriptive of the conversation topic. Use the same language as the user.'
    ),
});

const name = 'updateSessionTitle';

export const updateSessionTitleTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const { title } = input;
    await updateSessionTitle(context.workerId, title);
    await sendWebappEvent(context.workerId, { type: 'sessionTitleUpdate', newTitle: title });
    return `Session title updated to: ${title}`;
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Update the title of the current session. Use this tool to set or change the session title so users can easily identify the conversation topic in the session list.

## When to use:
- At the end of your FIRST turn, after understanding what the user wants
- Proactively whenever the conversation topic evolves or shifts to a different focus. Don't leave a stale title.
- When the user explicitly asks to rename the session

## Guidelines:
- Keep titles concise (under 30 characters preferred)
- Make titles descriptive of the current main topic or task
- Use the same language the user is using`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
