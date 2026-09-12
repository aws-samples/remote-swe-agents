import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { getSession, getChildSessions, reparentSessions } from '../../lib/sessions';
import { createSession } from '../../lib/create-session';
import { getWebappSessionUrl } from '../../lib/webapp-origin';
import { copySessionParticipants } from '../../lib/session-participants';

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
  role: z
    .enum(['child', 'successor', 'independent'])
    .describe(
      'The relationship of the new session to the current one. Must be explicitly specified.\n' +
        '- "child": Sub-task of the current session. Current session becomes the parent.\n' +
        '- "successor": Hand over coordination to a fresh parent. Current session + its children are re-parented under the new session. Use when the user asks for a session handover.\n' +
        '- "independent": A completely separate top-level session for an unrelated topic.'
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

    const parentSessionId =
      input.role === 'child'
        ? context.workerId
        : input.role === 'successor'
          ? currentSession.parentSessionId
          : undefined;
    const creatorSessionId = input.role !== 'child' ? context.workerId : undefined;

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

    if (input.role === 'successor') {
      const children = await getChildSessions(context.workerId);
      const reparentIds = [context.workerId, ...children.map((c) => c.workerId)];
      await reparentSessions(workerId, reparentIds);

      try {
        await copySessionParticipants(context.workerId, workerId);
      } catch (e) {
        console.error('[create-session] Failed to copy participants to successor:', e);
      }

      const sessionUrl = await getWebappSessionUrl(workerId);
      const urlInfo = sessionUrl ? `\n- Web UI: ${sessionUrl}` : '';
      const slackInfo = currentSession.slackChannelId
        ? '\n- Slack: A new thread has been created in the same channel'
        : '';
      return `Parent handover complete.\n- New parent session: ${workerId}\n- Re-parented ${reparentIds.length} session(s) under it (this session + ${children.length} existing child session(s))${urlInfo}${slackInfo}`;
    }

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

## IMPORTANT — Choosing the right role:
The \`role\` parameter is REQUIRED. Pick the correct one:

- **"child"**: The new session is a sub-task of your current work. Use when:
  - The task is tightly coupled to the current session's context
  - You need to coordinate/aggregate results from the new session
  - The sub-task's progress should be visible in the current session's chat view

- **"successor"** (handover): Use when the user asks you to hand over or create a fresh coordinator. This creates a new top-level parent and re-parents the current session and all its children under it. Use when:
  - The user explicitly asks for a session handover
  - Your context has grown too large and you need a fresh coordinator
  - You want to keep child sessions running under a new parent

- **"independent"**: A completely separate session for a genuinely unrelated topic. Use when:
  - The task is entirely unrelated to the current session
  - The new session needs to communicate directly with the user on a different topic
  - The current session should not be a parent or have any structural relationship

**When in doubt, prefer "child" over "independent".** Most tasks spawned from an existing session are sub-tasks, not truly independent topics.

## Cost awareness:
- Creating a new session starts a new agent runtime, which incurs additional cost
- You SHOULD confirm with the user before creating a session (e.g. "Shall I create a new session for this?")

## Behavior:
- The new session inherits the current session's agent configuration (custom agent, runtime type, etc.)
- If the current session is linked to Slack, a new thread will be created in the same Slack channel
- The new session will start processing the message immediately after creation
- When creating child sessions, provide a descriptive 'agentName' so sibling agents can identify each other (e.g. "Frontend Dev", "Backend Dev")
- Use 'customAgentId' to assign a specific custom agent configuration to the new session (use listAgents to find IDs)`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
