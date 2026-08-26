import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { createCustomAgent } from '../../lib/custom-agent';
import { CustomAgent } from '../../schema';

const PENDING_DIR = tmpdir();
const PENDING_TTL_MS = 30 * 60 * 1000;

const pendingFilePath = (workerId: string) => join(PENDING_DIR, `.pending-create-agent-${workerId}`);

export type PendingAgentData = Omit<CustomAgent, 'PK' | 'SK' | 'createdAt' | 'updatedAt'>;

interface PendingFile {
  timestamp: number;
  data: PendingAgentData;
}

export const savePendingCreateAgent = (workerId: string, data: PendingAgentData) => {
  const payload: PendingFile = { timestamp: Date.now(), data };
  writeFileSync(pendingFilePath(workerId), JSON.stringify(payload), 'utf-8');
};

export const loadAndDeletePendingCreateAgent = (workerId: string): PendingFile | undefined => {
  const filePath = pendingFilePath(workerId);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    unlinkSync(filePath);
    return JSON.parse(raw) as PendingFile;
  } catch {
    return undefined;
  }
};

const inputSchema = z.object({});

const name = 'confirmCreateAgent';

export const confirmCreateAgentTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (_input: z.infer<typeof inputSchema>, context) => {
    const pending = loadAndDeletePendingCreateAgent(context.workerId);

    if (!pending) {
      return 'No pending createAgent to confirm. Call createAgent first.';
    }

    const elapsed = Date.now() - pending.timestamp;
    if (elapsed > PENDING_TTL_MS) {
      return `The pending createAgent request has expired (requested ${Math.round(elapsed / 60000)} minutes ago, TTL is 30 minutes). Please call createAgent again to start a new request.`;
    }

    const agent = await createCustomAgent(pending.data);

    return `Agent created successfully.\n- ID: ${agent.SK}\n- Name: ${agent.name}`;
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Confirm and execute a blocked createAgent call. Call this after createAgent returns a confirmation prompt for top-level agent creation. Only call this if the user explicitly approved creating the new top-level agent. If the user did NOT approve, do NOT call this tool.`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
