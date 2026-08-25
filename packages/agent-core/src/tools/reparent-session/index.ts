import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { getSession, reparentSessions } from '../../lib/sessions';

const inputSchema = z.object({
  sessionId: z.string().describe('The session ID to reparent (move under a new parent).'),
  newParentSessionId: z.string().describe('The session ID of the new parent.'),
});

const name = 'Reparent Session';

export const reparentSessionTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const { sessionId, newParentSessionId } = input;

    const callerSession = await getSession(context.workerId);
    if (!callerSession) {
      return 'Error: Could not retrieve current session information.';
    }

    const targetSession = await getSession(sessionId);
    if (!targetSession) {
      return `Error: Session ${sessionId} not found.`;
    }

    const callerIsTopLevel = !callerSession.parentSessionId;
    const callerIsTargetParent = targetSession.parentSessionId === context.workerId;
    const callerIsTarget = context.workerId === sessionId;

    if (!callerIsTopLevel && !callerIsTargetParent && !callerIsTarget) {
      return "Permission denied: only the target's current parent, the target itself, or a top-level session can reparent.";
    }

    if (sessionId === newParentSessionId) {
      return 'Error: Cannot set a session as its own parent.';
    }

    const newParent = await getSession(newParentSessionId);
    if (!newParent) {
      return `Error: New parent session ${newParentSessionId} not found.`;
    }

    const oldParentId = targetSession.parentSessionId ?? '(top-level)';

    try {
      await reparentSessions(newParentSessionId, [sessionId]);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return `Error: Reparent failed — ${message}`;
    }

    return (
      `Successfully reparented session ${sessionId} under ${newParentSessionId}.\n` +
      `- Previous parent: ${oldParentId}\n` +
      `- New parent: ${newParentSessionId}\n` +
      `Note: The webapp sidebar will reflect the change on next page load or realtime update.`
    );
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Move a session under a different parent session (reparent).

This updates the session's parentSessionId in DynamoDB. The session hierarchy in both the system prompt and the webapp sidebar will reflect the change.

Safety:
- Cycle detection is enforced: you cannot create circular parent chains.
- A session cannot be its own parent.

Permission: allowed when the caller is one of:
- The target session's current parent
- The target session itself
- A top-level (no parent) session

Parameters:
- sessionId: The session to move.
- newParentSessionId: The session that will become the new parent.`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
