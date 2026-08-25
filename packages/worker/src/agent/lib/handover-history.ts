import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { paginateQuery } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { getSession } from '@remote-swe-agents/agent-core/lib';
import type { MessageItem, SessionItem } from '@remote-swe-agents/agent-core/schema';

const HANDOVER_LOG_DIR = path.join(homedir(), '.remote-swe-workspace', '.handover-context');

export const getHandoverLogPath = (sourceSessionId: string): string =>
  path.join(HANDOVER_LOG_DIR, `previous-session-log-${sourceSessionId}.md`);

const formatTimestamp = (sk: string): string => {
  const ts = parseInt(sk, 10);
  if (isNaN(ts)) return sk;
  return new Date(ts).toISOString();
};

const renderContentBlocks = (item: MessageItem): string => {
  let blocks: any[];
  try {
    const parsed = JSON.parse(item.content);
    blocks = Array.isArray(parsed) ? parsed : [];
  } catch {
    return item.content || '';
  }

  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block?.text === 'string') {
      parts.push(block.text);
    }
    if (block?.toolUse) {
      const name = block.toolUse.name ?? 'unknown';
      const input = block.toolUse.input != null ? JSON.stringify(block.toolUse.input).slice(0, 500) : '';
      parts.push(`[Tool call: ${name}] ${input}`);
    }
    if (block?.toolResult) {
      const status = block.toolResult.status ?? 'success';
      const content = (block.toolResult.content ?? [])
        .map((c: any) => c?.text ?? '')
        .join('')
        .slice(0, 500);
      parts.push(`[Tool result (${status})]: ${content}`);
    }
    if (block?.image?.source?.s3Key) {
      parts.push(`[Image: s3://${block.image.source.s3Key}]`);
    }
    if (block?.file?.source?.s3Key) {
      const fileName = block.file.fileName ?? 'file';
      parts.push(`[File: ${fileName} — s3://${block.file.source.s3Key}]`);
    }
  }
  return parts.join('\n');
};

const EXCLUDED_MESSAGE_TYPES = new Set([
  'communicationLog',
  'userDeliveryLog',
  'internalError',
  'retriggerGiveup',
  'cancelledTurn',
]);

export const dumpHandoverHistory = async (session: SessionItem): Promise<string | undefined> => {
  const sourceSessionId = session.handoverSourceSessionId;
  if (!sourceSessionId) return undefined;

  const logPath = getHandoverLogPath(sourceSessionId);
  if (existsSync(logPath)) return logPath;

  const sourceSession = await getSession(sourceSessionId);
  if (!sourceSession) {
    console.warn('[handover-history] Source session not found:', sourceSessionId);
    return undefined;
  }
  if (sourceSession.handedOverTo && sourceSession.handedOverTo !== session.workerId) {
    console.warn(
      `[handover-history] Source session handedOverTo mismatch: expected ${session.workerId}, got ${sourceSession.handedOverTo}`
    );
    return undefined;
  }

  mkdirSync(HANDOVER_LOG_DIR, { recursive: true });

  const header = [
    `# Conversation History — Session ${sourceSessionId}`,
    '',
    `> This file contains the full conversation history from the predecessor session.`,
    `> Dumped at: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  writeFileSync(logPath, header, 'utf-8');

  const paginator = paginateQuery(
    { client: ddb },
    {
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `message-${sourceSessionId}`,
      },
    }
  );

  let hasItems = false;
  for await (const page of paginator) {
    if (!page.Items || page.Items.length === 0) continue;

    const chunk: string[] = [];
    for (const raw of page.Items) {
      const item = raw as unknown as MessageItem;
      if (EXCLUDED_MESSAGE_TYPES.has(item.messageType)) continue;

      hasItems = true;
      const timestamp = formatTimestamp(item.SK);
      const role = item.role ?? 'unknown';
      const messageType = item.messageType ? ` (${item.messageType})` : '';
      chunk.push(`### [${role}] ${timestamp}${messageType}`);
      chunk.push('');
      chunk.push(renderContentBlocks(item));
      chunk.push('');
    }
    if (chunk.length > 0) {
      appendFileSync(logPath, chunk.join('\n'), 'utf-8');
    }
  }

  if (!hasItems) {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(logPath);
    return undefined;
  }

  return logPath;
};
