import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { getSession, getDescendantSessions } from '../../lib/sessions';
import { getConversationHistory } from '../../lib/messages';
import type { SessionItem, MessageItem } from '../../schema';

const inputSchema = z.object({
  sessionId: z.string().describe('The session ID to export diagnostics for.'),
  includeTree: z
    .boolean()
    .default(false)
    .optional()
    .describe('When true, recursively export all descendant sessions. Default: false.'),
  outputPath: z.string().optional().describe('Output directory path. Default: /tmp/session-diagnostics/<sessionId>/'),
  maxSessions: z
    .number()
    .int()
    .positive()
    .default(50)
    .optional()
    .describe('Maximum number of sessions to export in tree mode. Default: 50.'),
});

const name = 'Export Session Diagnostics';

interface ExportResult {
  sessionId: string;
  outputPath: string;
  messageCount: number;
  children?: ExportResult[];
}

async function exportSingleSession(session: SessionItem, outputDir: string): Promise<ExportResult> {
  mkdirSync(outputDir, { recursive: true });

  const { items } = await getConversationHistory(session.workerId);

  const sessionMetadata = {
    workerId: session.workerId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    agentStatus: session.agentStatus,
    instanceStatus: session.instanceStatus,
    title: session.title,
    parentSessionId: session.parentSessionId,
    customAgentId: session.customAgentId,
    runtimeType: session.runtimeType,
    agentName: session.agentName,
    sessionCost: session.sessionCost,
    lastMessage: session.lastMessage,
    lastMessageAt: session.lastMessageAt,
    handedOverTo: session.handedOverTo,
    rewindState: session.rewindState,
  };

  const messages = items.map((item: MessageItem) => ({
    SK: item.SK,
    role: item.role,
    messageType: item.messageType,
    tokenCount: item.tokenCount,
    content: safeParseContent(item.content),
    thinkingBudget: item.thinkingBudget,
    senderSessionId: item.senderSessionId,
    senderAgentName: item.senderAgentName,
    targetSessionId: item.targetSessionId,
    targetAgentName: item.targetAgentName,
    isAcknowledge: item.isAcknowledge,
    timestamp: parseInt(item.SK, 10),
  }));

  writeFileSync(path.join(outputDir, 'session.json'), JSON.stringify(sessionMetadata, null, 2));
  writeFileSync(path.join(outputDir, 'messages.json'), JSON.stringify(messages, null, 2));

  return {
    sessionId: session.workerId,
    outputPath: outputDir,
    messageCount: messages.length,
  };
}

function safeParseContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

async function exportSessionTree(
  session: SessionItem,
  outputDir: string,
  descendants: SessionItem[]
): Promise<ExportResult> {
  const result = await exportSingleSession(session, outputDir);

  const children = descendants.filter((s) => s.parentSessionId === session.workerId);
  if (children.length > 0) {
    const childrenDir = path.join(outputDir, 'children');
    mkdirSync(childrenDir, { recursive: true });

    result.children = [];
    for (const child of children) {
      const childDir = path.join(childrenDir, child.workerId);
      const childResult = await exportSessionTree(child, childDir, descendants);
      result.children.push(childResult);
    }
  }

  return result;
}

export const exportSessionDiagnosticsTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const { sessionId, includeTree, maxSessions } = input;

    const session = await getSession(sessionId);
    if (!session) {
      return `Error: Session ${sessionId} not found.`;
    }

    if (sessionId !== context.workerId) {
      const callerSession = await getSession(context.workerId);
      if (!callerSession) {
        return 'Error: Could not retrieve current session information.';
      }

      const callerIsTopLevel = !callerSession.parentSessionId;
      const callerIsTargetParent = session.parentSessionId === context.workerId;

      if (!callerIsTopLevel && !callerIsTargetParent) {
        return "Permission denied: only the target's current parent, the target itself, or a top-level session can export another session's diagnostics.";
      }
    }

    const outputDir = input.outputPath ?? `/tmp/session-diagnostics/${sessionId}`;

    if (!includeTree) {
      const result = await exportSingleSession(session, outputDir);
      return (
        `Exported session diagnostics to ${result.outputPath}\n` +
        `- session.json: session metadata\n` +
        `- messages.json: ${result.messageCount} message(s)\n`
      );
    }

    const descendants = await getDescendantSessions(sessionId);
    const limit = maxSessions ?? 50;
    const totalSessions = 1 + descendants.length;

    if (totalSessions > limit) {
      return `Error: Session tree contains ${totalSessions} sessions, which exceeds the maxSessions limit of ${limit}. Increase maxSessions or export individual sessions.`;
    }

    const result = await exportSessionTree(session, outputDir, descendants);

    const totalMessages = countMessages(result);

    return (
      `Exported session tree diagnostics to ${outputDir}\n` +
      `- Total sessions: ${totalSessions}\n` +
      `- Total messages: ${totalMessages}\n` +
      `- Structure:\n${formatTree(result, '  ')}`
    );
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Export session diagnostics data (DynamoDB records) to local files for debugging.

Dumps the full session metadata and all messages (including errors, tool use details, and raw content) to JSON files on disk.

Use this when searchSessions doesn't provide enough detail — for example when you need to inspect raw tool use payloads, error messages, token counts, or the complete message timeline.

Permission: When exporting another session's diagnostics (sessionId != self), the caller must be one of:
- The target session's current parent
- The target session itself
- A top-level (no parent) session

Parameters:
- sessionId (required): The session to export.
- includeTree (optional, default: false): When true, recursively exports all descendant sessions in a nested folder structure.
- outputPath (optional): Output directory. Default: /tmp/session-diagnostics/<sessionId>/
- maxSessions (optional, default: 50): Maximum number of sessions to export in tree mode. Returns an error if exceeded.

Output structure (single session):
  <outputPath>/session.json    — session metadata (status, agent, title, etc.)
  <outputPath>/messages.json   — all messages in chronological order

Output structure (tree mode):
  <sessionId>/
    session.json
    messages.json
    children/
      <child-id>/
        session.json
        messages.json
        children/
          ...`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};

function countMessages(result: ExportResult): number {
  let count = result.messageCount;
  if (result.children) {
    for (const child of result.children) {
      count += countMessages(child);
    }
  }
  return count;
}

function formatTree(result: ExportResult, indent: string): string {
  let output = `${indent}${result.sessionId} (${result.messageCount} msgs)\n`;
  if (result.children) {
    for (const child of result.children) {
      output += formatTree(child, indent + '  ');
    }
  }
  return output;
}
