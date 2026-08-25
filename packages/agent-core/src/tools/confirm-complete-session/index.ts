import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { getSession, updateSessionAgentStatus, stopWorkerInstance } from '../../lib';
import { sendWebappEvent } from '../../lib/events';
import { terminatePreview } from '../preview';

const PENDING_DIR = tmpdir();

const pendingFilePath = (workerId: string) => join(PENDING_DIR, `.pending-complete-session-${workerId}`);

export const savePendingCompleteSession = (workerId: string) => {
  writeFileSync(pendingFilePath(workerId), 'pending', 'utf-8');
};

export const loadAndDeletePendingCompleteSession = (workerId: string): boolean => {
  const filePath = pendingFilePath(workerId);
  try {
    readFileSync(filePath, 'utf-8');
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
};

const inputSchema = z.object({});

const name = 'Confirm Complete Session';

export const confirmCompleteSessionTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (_input: z.infer<typeof inputSchema>, context) => {
    const hasPending = loadAndDeletePendingCompleteSession(context.workerId);

    if (!hasPending) {
      return 'No pending completeSession to confirm. Call completeSession first.';
    }

    const session = await getSession(context.workerId);
    if (!session) {
      return 'Session not found.';
    }
    if (session.agentStatus === 'completed') {
      return 'Session is already completed.';
    }

    await updateSessionAgentStatus(context.workerId, 'completed');
    await sendWebappEvent(context.workerId, { type: 'agentStatusUpdate', status: 'completed' });

    try {
      await terminatePreview(context.workerId);
    } catch (e: any) {
      console.error(`[confirmCompleteSession] Preview cleanup failed for ${context.workerId}:`, e.message);
    }

    const runtimeType = session.runtimeType ?? 'ec2';
    await stopWorkerInstance(context.workerId, runtimeType);

    return 'Session marked as completed and worker stopped.';
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Confirm and execute a blocked completeSession call. Call this after completeSession returns a confirmation prompt. Only call this if the user explicitly asked you to close/complete the session. If the user did NOT instruct you to complete, do NOT call this tool.`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
