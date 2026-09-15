import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { getSession } from '../../lib/sessions';
import { getConversationHistory } from '../../lib/messages';
import type { ToolResultContentBlock } from '@aws-sdk/client-bedrock-runtime';

type ToolContext = {
  workerId: string;
  toolUseId: string;
  globalPreferences: any;
  cancellationToken?: { readonly isCancelled: boolean };
};

type ToolHandler<Input> = (input: Input, context: ToolContext) => Promise<string | ToolResultContentBlock[]>;

const PENDING_DIR = tmpdir();

const pendingFilePath = (key: string, workerId: string) => join(PENDING_DIR, `.pending-${key}-${workerId}`);

export const savePendingState = (key: string, workerId: string, data: string) => {
  writeFileSync(pendingFilePath(key, workerId), data, 'utf-8');
};

export const loadAndDeletePendingState = (key: string, workerId: string): string | undefined => {
  const filePath = pendingFilePath(key, workerId);
  try {
    const content = readFileSync(filePath, 'utf-8');
    unlinkSync(filePath);
    return content;
  } catch {
    return undefined;
  }
};

export interface ChildGuardOptions<Input> {
  pendingKey: string;
  confirmToolName: string;
  serializePending: (input: Input) => string;
  toolDisplayName: string;
}

export function withChildSessionGuard<Input>(
  handler: ToolHandler<Input>,
  options: ChildGuardOptions<Input>
): ToolHandler<Input> {
  return async (input: Input, context: ToolContext) => {
    const session = await getSession(context.workerId);

    if (session?.parentSessionId) {
      const { items } = await getConversationHistory(context.workerId);
      const triggeringItem = items.findLast(
        (i) => !['toolUse', 'toolResult', 'assistant', 'errorFeedback'].includes(i.messageType)
      );
      const triggeringMessageType = triggeringItem?.messageType ?? 'unknown';

      if (triggeringMessageType !== 'userMessage') {
        const userMessageCount = items.filter((i) => i.messageType === 'userMessage').length;
        const senderInfo =
          (triggeringItem as any)?.senderAgentName ?? (triggeringItem as any)?.senderSessionId ?? 'system';

        if (userMessageCount === 0) {
          return [
            `ERROR: ${options.toolDisplayName} is not available in this child session.`,
            `The user has never sent a message to this session directly (0 user messages), which means they do not expect to receive messages from here.`,
            ``,
            `You MUST use sendMessageToAgent to report to your parent session instead.`,
            `Do NOT call ${options.confirmToolName} — it will not work for this case.`,
          ].join('\n');
        }

        savePendingState(options.pendingKey, context.workerId, options.serializePending(input));

        return [
          `WARNING: You are almost certainly making a mistake. There is a 99% chance you should NOT send this directly to the user.`,
          ``,
          `This is a child session and the last triggering message is NOT from the user:`,
          `- Messages from user in this session: ${userMessageCount}`,
          `- Last message is from: ${triggeringMessageType} (${senderInfo})`,
          ``,
          `The only scenario where sending directly to the user is appropriate is when the user previously asked you to investigate something directly in this session and you are reporting back after a long delay.`,
          ``,
          `In almost all cases, you should use sendMessageToAgent to report to your parent session instead.`,
          `If you are ABSOLUTELY CERTAIN this is one of the rare exceptions, call ${options.confirmToolName} to proceed.`,
        ].join('\n');
      }
    }

    return handler(input, context);
  };
}

export interface ConfirmToolOptions {
  name: string;
  description: string;
  pendingKey: string;
  noPendingMessage?: string;
  execute: (workerId: string, pendingData: string) => Promise<string>;
}

export function createConfirmTool(options: ConfirmToolOptions): ToolDefinition<Record<string, never>> {
  const inputSchema = z.object({});

  return {
    name: options.name,
    handler: async (_input: Record<string, never>, context: ToolContext) => {
      const pending = loadAndDeletePendingState(options.pendingKey, context.workerId);
      if (!pending) {
        return options.noPendingMessage ?? `No pending action to confirm. Use the corresponding tool first.`;
      }
      return options.execute(context.workerId, pending);
    },
    schema: inputSchema,
    toolSpec: async () => ({
      name: options.name,
      description: options.description,
      inputSchema: {
        json: zodToJsonSchemaBody(inputSchema),
      },
    }),
  };
}
