import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { sendMessageToUser } from '../report-progress';

const PENDING_DIR = tmpdir();

const pendingFilePath = (workerId: string) => join(PENDING_DIR, `.pending-user-message-${workerId}`);

export const savePendingUserMessage = (workerId: string, message: string) => {
  writeFileSync(pendingFilePath(workerId), message, 'utf-8');
};

export const loadAndDeletePendingUserMessage = (workerId: string): string | undefined => {
  const filePath = pendingFilePath(workerId);
  try {
    const message = readFileSync(filePath, 'utf-8');
    unlinkSync(filePath);
    return message;
  } catch {
    return undefined;
  }
};

const inputSchema = z.object({});

const name = 'confirmSendToUser';

export const confirmSendToUserTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (_input: z.infer<typeof inputSchema>, context) => {
    const pendingMessage = loadAndDeletePendingUserMessage(context.workerId);

    if (!pendingMessage) {
      return 'No pending message to confirm. Use sendMessageToUser first.';
    }

    await sendMessageToUser(context.workerId, pendingMessage);
    return 'Successfully sent the message to the user.';
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Confirm and send a blocked sendMessageToUser call in a child session. Call this after sendMessageToUser returns a confirmation prompt. If you do not want to send the message, simply do not call this tool.`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
