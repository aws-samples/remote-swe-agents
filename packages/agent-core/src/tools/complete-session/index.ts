import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { getSession, updateSessionAgentStatus, stopWorkerInstance } from '../../lib';
import { sendWebappEvent } from '../../lib/events';
import { savePendingCompleteSession } from '../confirm-complete-session';
import { terminatePreview } from '../preview';

const inputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('The session ID to complete. Defaults to the current session if not specified.'),
});

const name = 'Complete Session';

export const completeSessionTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const targetSessionId = input.sessionId ?? context.workerId;
    const isSelf = targetSessionId === context.workerId;

    const callerSession = await getSession(context.workerId);
    if (!callerSession) {
      return 'Caller session not found.';
    }

    const isChild = !!callerSession.parentSessionId;

    if (isChild && !isSelf) {
      return 'Permission denied: child/sub-agent sessions can only complete themselves, not other sessions.';
    }

    const targetSession = isSelf ? callerSession : await getSession(targetSessionId);
    if (!targetSession) {
      return 'Target session not found.';
    }
    if (targetSession.agentStatus === 'completed') {
      return 'Session is already completed.';
    }

    if (!isChild && isSelf) {
      savePendingCompleteSession(context.workerId);
      return [
        `CONFIRMATION REQUIRED: You are about to complete a top-level session.`,
        ``,
        `Only call Confirm Complete Session if the user EXPLICITLY instructed you to end/close/complete this session.`,
        `If the user did NOT give such instruction, your mission is still in progress — do NOT complete.`,
        ``,
        `To proceed: call Confirm Complete Session.`,
        `To abort: simply do not call Confirm Complete Session and continue working.`,
      ].join('\n');
    }

    await updateSessionAgentStatus(targetSessionId, 'completed');
    await sendWebappEvent(targetSessionId, { type: 'agentStatusUpdate', status: 'completed' });

    try {
      await terminatePreview(targetSessionId);
    } catch (e: any) {
      console.error(`[completeSession] Preview cleanup failed for ${targetSessionId}:`, e.message);
    }

    const runtimeType = targetSession.runtimeType ?? 'ec2';
    await stopWorkerInstance(targetSessionId, runtimeType);

    return 'Session marked as completed and worker stopped.';
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Complete a session by ID, stopping its worker. If a new message arrives later, the session will automatically resume.

This action is idempotent — calling it on an already-completed session is a no-op.

Parameters:
- sessionId (optional): The ID of the session to complete. Defaults to the current session if omitted.

Permission model:
- Child/sub-agent sessions: Can only complete themselves (the default). Specifying another session's ID will be rejected.
- Top-level sessions (no parent): Can complete any session by ID.
  - Completing another session: Executes immediately with no confirmation.
  - Completing itself (self-completion): Triggers a confirmation guard — you must then call Confirm Complete Session to proceed. This guard exists because top-level sessions should only self-complete when the user explicitly asks.

You can determine whether you are a child session by checking the Session Hierarchy section in your context. If it says "You are a child agent" or shows a Parent session, you are a child session. If there is no Session Hierarchy section or it says "You are a parent agent", you are a top-level session.`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
