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
  agentName: z
    .string()
    .max(30)
    .optional()
    .describe(
      'A display name for the new session\'s agent (e.g. "Frontend Dev", "Test Runner"). Used to identify the agent in inter-agent communication. Recommended when creating child sessions.'
    ),
  customAgentId: z
    .string()
    .optional()
    .describe(
      "ID of a custom agent to use for the new session. If omitted, the new session inherits the current session's agent configuration. Use listAgents to find available agent IDs."
    ),
  asChild: z
    .boolean()
    .optional()
    .describe(
      'When true, the new session is created as a child of the CURRENT session (automatically uses the current session ID as the parent). This groups related sessions together and aggregates child messages in the parent chat view. Default: false (independent session).'
    ),
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

    const parentSessionId = input.asChild ? context.workerId : undefined;
    const creatorSessionId = !input.asChild ? context.workerId : undefined;

    const workerId = await createSession({
      message: input.message,
      initiator,
      customAgentId: input.customAgentId || currentSession.customAgentId,
      title: input.title,
      agentName: input.agentName,
      parentSessionId,
      creatorSessionId,
      slackChannelId: currentSession.slackChannelId,
      slackMentionUserId,
    });

    const sessionUrl = await getWebappSessionUrl(workerId);
    const urlInfo = sessionUrl ? `\n- Web UI: ${sessionUrl}` : '';
    const slackInfo = currentSession.slackChannelId
      ? '\n- Slack: A new thread has been created in the same channel'
      : '';

    const parentInfo = parentSessionId ? `\n- Parent Session: ${parentSessionId}` : '';
    const nameInfo = input.agentName ? `\n- Agent Name: ${input.agentName}` : '';

    return `New session created successfully.\n- Session ID: ${workerId}\n- Title: ${input.title ?? '(auto-generated)'}${nameInfo}\n- Message: ${input.message}${parentInfo}${urlInfo}${slackInfo}`;
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
- You will receive the new session ID in the response
- Use asChild=true to group related sessions together (e.g. sub-tasks of a larger task). The parent session's chat view will show messages from child sessions. Leave it false or omit for completely independent sessions.
- When creating child sessions, provide a descriptive 'agentName' so sibling agents can identify each other (e.g. "Frontend Dev", "Backend Dev").
- Use 'customAgentId' to assign a specific custom agent configuration to the new session (use listAgents to find IDs).

## Child vs Independent Session Guidelines:
- **Child session (asChild=true)**: Use ONLY when the task is a sub-task of your current session. The parent acts as a coordinator/relay. Choose this when:
  - The task is tightly coupled to the parent session's context
  - The parent needs to aggregate or coordinate the results
  - The sub-task's progress should be visible in the parent's chat view
- **Independent session (asChild=false or omitted)**: Use when the task can stand on its own. Choose this when:
  - The task is unrelated or loosely related to the current session
  - The new session needs to communicate directly with the user
  - The parent session may become idle/sleep and shouldn't block the new session

## Decision criteria:
- Is the task tightly dependent on the parent session's context? → Child
- Can the task complete independently without parent coordination? → Independent
- Does the new session need direct user communication? → Independent`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
