import { Message } from '@aws-sdk/client-bedrock-runtime';
import { PutCommand, QueryCommand, UpdateCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';
import sharp from 'sharp';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ddb, TableName } from './aws/ddb';
import { writeBytesToKey, getBytesFromKey, BucketName } from './aws/s3';
import { ensureImageWithinBounds } from './image-resize';
import { sendWebappEvent } from './events';
import { sendMessageToSlack } from './slack';
import { updateSessionLastMessage } from './sessions';
import { getWebappSessionUrl } from './webapp-origin';
import {
  MessageItem,
  INTERNAL_ERROR_MESSAGE_TYPE,
  RETRIGGER_GIVEUP_MESSAGE_TYPE,
  CANCELLED_TURN_MESSAGE_TYPE,
} from '../schema';

// Maximum input token count before applying middle-out strategy
export const MAX_INPUT_TOKEN = 80_000;

const PID_DIR = path.join(tmpdir(), '.remote-swe-pids');

export const saveToolUseMessage = async (
  workerId: string,
  toolUseMessage: Message,
  outputTokenCount: number,
  thinkingBudget?: number
) => {
  const now = Date.now();
  const toolUseItem: MessageItem = {
    PK: `message-${workerId}`,
    SK: `${String(now).padStart(15, '0')}`,
    content: await preProcessMessageContent(toolUseMessage.content, workerId),
    role: toolUseMessage.role ?? 'unknown',
    tokenCount: outputTokenCount,
    messageType: 'toolUse',
    thinkingBudget,
  };

  await ddb.send(
    new PutCommand({
      TableName,
      Item: toolUseItem,
    })
  );
  return toolUseItem;
};

export const saveToolResultMessage = async (workerId: string, toolResultMessage: Message, toolUseSK: string) => {
  const toolUseSKNum = Number(toolUseSK);
  const toolResultItem: MessageItem = {
    PK: `message-${workerId}`,
    SK: `${String(toolUseSKNum + 1).padStart(15, '0')}`,
    content: await preProcessMessageContent(toolResultMessage.content, workerId),
    role: toolResultMessage.role ?? 'unknown',
    tokenCount: 0,
    messageType: 'toolResult',
  };

  await ddb.send(
    new PutCommand({
      TableName,
      Item: toolResultItem,
    })
  );
  return toolResultItem;
};

export const repairDanglingToolUse = async (workerId: string, items: MessageItem[]): Promise<MessageItem[]> => {
  const repaired: MessageItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.messageType === 'toolUse') {
      const next = items[i + 1];
      if (!next || next.messageType !== 'toolResult') {
        const content = JSON.parse(item.content);
        const toolUses: { toolUseId: string; name?: string }[] = content
          .filter((c: any) => c.toolUse?.toolUseId)
          .map((c: any) => ({ toolUseId: c.toolUse.toolUseId, name: c.toolUse.name }));

        const toolResultContent = toolUses.map(({ toolUseId, name }) => {
          let message = 'This tool execution was interrupted and no result is available.';

          // Try to read PID info from file if it was an executeCommand
          if (name === 'executeCommand') {
            try {
              const pidFilePath = path.join(PID_DIR, toolUseId);
              if (existsSync(pidFilePath)) {
                const pidData = JSON.parse(readFileSync(pidFilePath, 'utf-8'));
                message = `This tool execution was interrupted and no result is available. The process may still be running (PID: ${pidData.pid}, command: ${pidData.command}). You can check with \`ps -p ${pidData.pid}\`.`;
                try {
                  unlinkSync(pidFilePath);
                } catch {
                  // ignore cleanup errors
                }
              }
            } catch (e) {
              // ignore read errors
            }
          }

          return {
            toolResult: {
              toolUseId,
              content: [{ text: message }],
            },
          };
        });

        const toolResultItem: MessageItem = {
          PK: `message-${workerId}`,
          SK: `${String(Number(item.SK) + 1).padStart(15, '0')}`,
          content: JSON.stringify(toolResultContent),
          role: 'user',
          tokenCount: 0,
          messageType: 'toolResult',
        };

        await ddb.send(
          new PutCommand({
            TableName,
            Item: toolResultItem,
          })
        );
        console.log(`Repaired dangling toolUse at SK=${item.SK} with dummy toolResult at SK=${toolResultItem.SK}`);
        repaired.push(toolResultItem);
      } else {
        // Check for PARTIAL toolResult (some toolUseIds missing from the toolResult message)
        const toolUseContent = JSON.parse(item.content);
        const toolResultContent = JSON.parse(next.content);
        const toolUseIds = new Set<string>(
          toolUseContent.filter((c: any) => c.toolUse?.toolUseId).map((c: any) => c.toolUse.toolUseId as string)
        );
        const toolResultIds = new Set<string>(
          toolResultContent
            .filter((c: any) => c.toolResult?.toolUseId)
            .map((c: any) => c.toolResult.toolUseId as string)
        );
        const missingIds = [...toolUseIds].filter((id) => !toolResultIds.has(id));
        if (missingIds.length > 0) {
          for (const missingId of missingIds) {
            toolResultContent.push({
              toolResult: {
                toolUseId: missingId,
                content: [
                  {
                    text: 'This tool execution was interrupted and no result is available.',
                  },
                ],
              },
            });
          }
          const updatedContent = JSON.stringify(toolResultContent);
          await ddb.send(
            new PutCommand({
              TableName,
              Item: { ...next, content: updatedContent },
            })
          );
          console.log(
            `Repaired partial toolResult at SK=${next.SK}: added ${missingIds.length} missing result(s) for toolUseIds: ${missingIds.join(', ')}`
          );
          next.content = updatedContent;
        }
      }
    }
  }
  return repaired;
};

export const saveConversationHistory = async (
  workerId: string,
  message: Message,
  tokenCount: number,
  messageType: string,
  thinkingBudget?: number,
  options: { ensureAfterSK?: string } = {}
) => {
  // Ordering guard: the end-of-turn assistant message must never sort BEFORE
  // an intra-turn message (a `sendMessageToAgent` / `sendMessageToUser` emitted
  // earlier in the same turn). Because every SK is `Date.now()` at write time,
  // a delayed final write could otherwise take a timestamp LARGER than an
  // intermediate whose own write was delayed. When `ensureAfterSK` is supplied
  // we clamp the SK to be strictly greater than it, preserving intra-turn
  // order. Callers pass the max SK observed in the session so far.
  let skNum = Date.now();
  if (options.ensureAfterSK) {
    const after = Number(options.ensureAfterSK);
    if (Number.isFinite(after) && after >= skNum) {
      skNum = after + 1;
    }
  }
  const item = {
    PK: `message-${workerId}`,
    SK: `${String(skNum).padStart(15, '0')}`, // make sure it can be sorted in dictionary order
    content: await preProcessMessageContent(message.content, workerId),
    role: message.role ?? 'unknown',
    tokenCount,
    messageType,
    thinkingBudget,
  } satisfies MessageItem;

  await ddb.send(
    new PutCommand({
      TableName,
      Item: item,
    })
  );
  return item;
};

export const updateMessageTokenCount = async (workerId: string, messageSK: string, tokenCount: number) => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: `message-${workerId}`,
        SK: messageSK,
      },
      UpdateExpression: 'SET tokenCount = :tokenCount',
      ExpressionAttributeValues: {
        ':tokenCount': tokenCount,
      },
    })
  );
};

export interface GetConversationHistoryOptions {
  /**
   * When true, return all messages without filtering.
   * When false/omitted, internal-only bookkeeping rows (`internalError`,
   * `retriggerGiveup`, `cancelledTurn`) are excluded. These rows are written
   * by the kiro-cli backend for debugging / recovery bookkeeping and must
   * never enter an LLM context or reach the UX.
   *
   * Rule of thumb:
   * - LLM-facing / UI-facing callers → omit / false
   * - recovery-bookkeeping callers that must see the raw rows (e.g. the
   *   retrigger burst accounting in the worker) → true
   */
  includeAll?: boolean;
}

export const getConversationHistory = async (workerId: string, options: GetConversationHistoryOptions = {}) => {
  const paginator = paginateQuery(
    {
      client: ddb,
    },
    {
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `message-${workerId}`,
      },
    }
  );
  const items: MessageItem[] = [];
  for await (const page of paginator) {
    if (page.Items == null) {
      continue;
    }
    items.push(...(page.Items as any));
  }

  const filteredItems = options.includeAll
    ? items
    : items.filter(
        (item) =>
          item.messageType !== INTERNAL_ERROR_MESSAGE_TYPE &&
          item.messageType !== RETRIGGER_GIVEUP_MESSAGE_TYPE &&
          item.messageType !== CANCELLED_TURN_MESSAGE_TYPE
      );

  return { items: filteredItems, slackUserId: searchForLastSlackUserId(filteredItems) };
};

const searchForLastSlackUserId = (items: MessageItem[]) => {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].slackUserId) {
      return items[i].slackUserId;
    }
  }
};

export const middleOutFiltering = async (items: MessageItem[], maxInputToken = MAX_INPUT_TOKEN) => {
  // Belt-and-suspenders guard: the internal-only markers (`internalError`,
  // `retriggerGiveup`, `cancelledTurn`) must never enter an LLM context. They
  // are already filtered out by `getConversationHistory` by default, but if a
  // future caller accidentally passes `{ includeAll: true }` to a history
  // fetch that feeds an LLM, the tokenCount=0 on these rows would silently
  // inflate the real context and mislead this function. Drop them
  // unconditionally here so the LLM path is safe by construction.
  items = items.filter(
    (item) =>
      item.messageType !== INTERNAL_ERROR_MESSAGE_TYPE &&
      item.messageType !== RETRIGGER_GIVEUP_MESSAGE_TYPE &&
      item.messageType !== CANCELLED_TURN_MESSAGE_TYPE
  );

  // Calculate total token count to determine if we need middle-out filtering
  let totalTokenCount = items.reduce((sum: number, item) => sum + item.tokenCount, 0);
  const headRatio = 0.6;
  const tailRatio = 1 - headRatio;

  // Apply middle-out strategy if token count exceeds the maximum
  if (totalTokenCount < maxInputToken) {
    return { items, totalTokenCount, messages: await itemsToMessages(items) };
  }
  console.log(`Applying middle-out strategy. Total tokens: ${totalTokenCount}, max tokens: ${maxInputToken}`);

  totalTokenCount = 0;
  // Get front messages until we reach half of max tokens
  const frontMessages: MessageItem[] = [];
  let frontTokenCount = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    frontTokenCount += item.tokenCount;

    // always include the first message.
    if (i == 0 || frontTokenCount <= maxInputToken * headRatio) {
      frontMessages.push(item);
      totalTokenCount += item.tokenCount;
    } else {
      break;
    }
  }

  // Get end messages until we reach half of max tokens
  const endMessages: MessageItem[] = [];
  let endTokenCount = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    endTokenCount += item.tokenCount;

    if (endTokenCount <= maxInputToken * tailRatio) {
      endMessages.unshift(item); // Add to start of array to maintain order
      totalTokenCount += item.tokenCount;
    } else {
      break;
    }
  }

  // If the last message in front is a toolUse, remove it
  // (because we don't want to split toolUse-toolResult pairs)
  if (frontMessages.length > 0 && frontMessages[frontMessages.length - 1].messageType === 'toolUse') {
    const item = frontMessages.pop()!;
    totalTokenCount -= item.tokenCount;
  }

  // If the first message in end is a toolResult, remove it
  // (because we don't want to split toolUse-toolResult pairs)
  if (endMessages.length > 0 && endMessages[0].messageType === 'toolResult') {
    const item = endMessages.shift()!;
    totalTokenCount -= item.tokenCount;
  }

  items = [...frontMessages, ...endMessages];
  // Combine front and end messages
  return { items, totalTokenCount, messages: await itemsToMessages(items) };
};

export const noOpFiltering = async (items: MessageItem[]) => {
  let totalTokenCount = items.reduce((sum: number, item) => sum + item.tokenCount, 0);
  return { items, totalTokenCount, messages: await itemsToMessages(items) };
};

const itemsToMessages = async (items: MessageItem[]) => {
  return (await Promise.all(
    items.map(async (item) => ({
      role: item.role,
      content: await postProcessMessageContent(item.content),
    }))
  )) as Message[];
};

/**
 * process message content before saving it to DB
 */
const preProcessMessageContent = async (content: Message['content'], workerId: string) => {
  content = structuredClone(content) ?? [];

  for (const c of content) {
    // store image in toolResult content to S3
    if (c.toolResult?.content) {
      for (const cc of c.toolResult.content) {
        if (cc.image?.source?.bytes != null) {
          const bytes = cc.image.source.bytes;
          const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))).toString('hex');
          const s3Key = `${workerId}/${hash}.${cc.image.format}`;
          await writeBytesToKey(s3Key, bytes);
          const newContent = cc.image.source as any;
          delete newContent['bytes'];
          newContent.s3Key = s3Key;
        }
      }
    }
  }

  return JSON.stringify(content);
};

const imageCache: Record<string, { data: Uint8Array; localPath: string; format: string }> = {};
const fileCache: Record<string, { localPath: string }> = {};
let imageSeqNo = 0;
let fileSeqNo = 0;

const ensureImagesDirectory = () => {
  const imagesDir = path.join(tmpdir(), `.remote-swe-images`);
  if (!existsSync(imagesDir)) {
    mkdirSync(imagesDir, { recursive: true });
  }
  return imagesDir;
};

const ensureFilesDirectory = () => {
  const filesDir = path.join(tmpdir(), `.remote-swe-files`);
  if (!existsSync(filesDir)) {
    mkdirSync(filesDir, { recursive: true });
  }
  return filesDir;
};

const saveImageToLocalFs = async (imageBuffer: Uint8Array): Promise<string> => {
  const imagesDir = ensureImagesDirectory();

  // Convert webp to jpeg for better compatibility with CLI tools
  const jpegBuffer = await sharp(imageBuffer).jpeg({ quality: 85 }).toBuffer();
  const extension = 'jpeg';

  // Create path with sequence number
  const fileName = `image${imageSeqNo}.${extension}`;
  const filePath = path.join(imagesDir, fileName);

  // Write image to file
  writeFileSync(filePath, jpegBuffer);

  // Increment sequence number for next image
  imageSeqNo++;

  // Return the path in the format specified in the issue
  return filePath;
};

const saveFileToLocalFs = async (fileBuffer: Uint8Array, fileName: string): Promise<string> => {
  const filesDir = ensureFilesDirectory();

  const filePath = path.join(filesDir, `${fileSeqNo}_${fileName}`);
  writeFileSync(filePath, fileBuffer);
  fileSeqNo++;

  return filePath;
};

/**
 * Resolve a `file` block's S3 key to a path on the local filesystem so a
 * downstream tool (Bedrock Converse text-block fallback, or kiro-cli's
 * native `read` / `shell`) can open the bytes without going through S3.
 *
 * Memoised on `s3Key` via the module-level `fileCache` so the same
 * attachment is downloaded at most once per worker process — the same
 * contract `postProcessMessageContent` has historically relied on for
 * the Bedrock path. The kiro-cli current-turn renderer reuses this
 * helper so both backends produce a byte-identical local-FS layout for
 * the agent (`/tmp/.remote-swe-files/${seq}_${fileName}`).
 *
 * Returns `localPath` plus the resolved `fileName` (falling back to the
 * tail of the s3Key when the original DDB block omitted it). The caller
 * is responsible for emitting the user-visible
 * `the file "${fileName}" is stored locally on ${localPath}` text — that
 * exact wording is part of the LLM-facing contract and is duplicated
 * verbatim by both backends to keep prompts identical.
 */
export const materializeFileBlock = async (
  s3Key: string,
  fileName?: string
): Promise<{ localPath: string; fileName: string }> => {
  const resolvedFileName = fileName || s3Key.split('/').pop() || 'file';
  if (s3Key in fileCache) {
    return { localPath: fileCache[s3Key]!.localPath, fileName: resolvedFileName };
  }
  const fileBuffer = await getBytesFromKey(s3Key);
  const localPath = await saveFileToLocalFs(fileBuffer, resolvedFileName);
  fileCache[s3Key] = { localPath };
  return { localPath, fileName: resolvedFileName };
};

const imageBlockCache: Record<string, { originalPath: string; previewPath: string; fileName: string }> = {};

/**
 * Resolve an `image` block's S3 key to files on the local filesystem for the
 * kiro-cli renderer. `originalPath` contains the resized (<=1568px) image,
 * not the raw S3 original — the full-size original is only in S3; local disk
 * always has the clamped version. A JPEG preview is additionally written so
 * CLI-side image tooling has a universally readable format.
 */
export const materializeImageBlock = async (
  s3Key: string
): Promise<{ originalPath: string; previewPath: string; fileName: string; s3Uri: string }> => {
  const fileName = s3Key.split('/').pop() || 'image.png';
  const s3Uri = `s3://${BucketName}/${s3Key}`;

  if (s3Key in imageBlockCache) {
    return { ...imageBlockCache[s3Key]!, s3Uri };
  }

  const raw = await getBytesFromKey(s3Key);

  const resized = await ensureImageWithinBounds(raw);
  const originalPath = await saveFileToLocalFs(resized, fileName);

  const jpegPreview = await sharp(resized).jpeg({ quality: 85 }).toBuffer();
  const imagesDir = ensureImagesDirectory();
  const previewFileName = `image${imageSeqNo}.jpeg`;
  const previewPath = path.join(imagesDir, previewFileName);
  writeFileSync(previewPath, jpegPreview);
  imageSeqNo++;

  imageBlockCache[s3Key] = { originalPath, previewPath, fileName };
  return { originalPath, previewPath, fileName, s3Uri };
};

/**
 * process message content after getting it from DB
 */
const postProcessMessageContent = async (content: string) => {
  const contentArray = JSON.parse(content);
  const flattenedArray = [];

  for (const c of contentArray) {
    if (typeof c.image?.source?.s3Key == 'string') {
      const s3Key = c.image.source.s3Key as string;
      let imageBuffer: Uint8Array;
      let localPath: string;
      let imageFormat: string;

      if (s3Key in imageCache) {
        imageBuffer = imageCache[s3Key].data;
        localPath = imageCache[s3Key].localPath;
        imageFormat = imageCache[s3Key].format;
      } else if (['png', 'jpeg', 'gif', 'webp'].some((ext) => s3Key.endsWith(ext))) {
        imageBuffer = await getBytesFromKey(s3Key);
        localPath = await saveImageToLocalFs(imageBuffer);
        imageFormat = s3Key.split('.').pop()!;
      } else {
        const file = await getBytesFromKey(s3Key);
        imageBuffer = await sharp(file).webp({ lossless: false, quality: 80 }).toBuffer();
        localPath = await saveImageToLocalFs(imageBuffer);
        imageFormat = 'webp';
      }
      imageCache[s3Key] = { data: imageBuffer, localPath, format: imageFormat };

      flattenedArray.push({
        image: {
          format: imageFormat,
          source: {
            bytes: imageBuffer,
          },
        },
      });
      flattenedArray.push({
        text: `the image is stored locally on ${localPath}`,
      });
    } else if (typeof c.file?.source?.s3Key == 'string') {
      const s3Key = c.file.source.s3Key as string;
      const fileName = c.file.fileName || s3Key.split('/').pop() || 'file';
      let localPath: string;

      if (s3Key in fileCache) {
        localPath = fileCache[s3Key].localPath;
      } else {
        const fileBuffer = await getBytesFromKey(s3Key);
        localPath = await saveFileToLocalFs(fileBuffer, fileName);
        fileCache[s3Key] = { localPath };
      }

      flattenedArray.push({
        text: `the file "${fileName}" is stored locally on ${localPath}`,
      });
    } else if (c.toolResult?.content != null) {
      c.toolResult.content = await postProcessMessageContent(JSON.stringify(c.toolResult.content));
      flattenedArray.push(c);
    } else {
      flattenedArray.push(c);
    }
  }

  return flattenedArray;
};

export const sendSystemMessage = async (
  workerId: string,
  message: string,
  appendWebappUrl: boolean = false,
  skipWebappEmit: boolean = false,
  messageSK?: string
) => {
  // Webapp message emit is gated on `skipWebappEmit` so callers that have
  // already delivered the same text to the webapp through another channel can
  // avoid creating a duplicate `type:'message'` bubble — the webapp's
  // `SessionPageClient` does not deduplicate assistant messages by content,
  // so a re-emit would surface as a visual duplicate. Slack delivery is NEVER
  // gated by this flag.
  if (!skipWebappEmit) {
    await sendWebappEvent(workerId, {
      type: 'message',
      role: 'assistant',
      message,
      ...(messageSK ? { messageSK } : {}),
    });
  }

  // Update the session's list-preview (lastMessage) and ordering timestamp
  // (lastMessageAt) ONLY when the message is persisted to DDB (indicated by
  // `messageSK`). Non-persisted messages (e.g. kill-timer "Going to sleep")
  // are transient real-time notifications that should NOT reorder the session
  // list, and don't survive a page refresh.
  if (messageSK) {
    try {
      const cleanMessage = message.replace(/^<@[A-Z0-9]+>\s*/, '');
      const lastMessagePreview = cleanMessage.slice(0, 500);
      await updateSessionLastMessage(workerId, lastMessagePreview);
      await sendWebappEvent(workerId, {
        type: 'lastMessageUpdate',
        lastMessage: lastMessagePreview,
        lastMessageAt: Date.now(),
      });
    } catch (e) {
      console.error('[sendSystemMessage] lastMessageUpdate best-effort failed:', e);
    }
  }

  // For Slack, optionally append webapp URL
  if (appendWebappUrl) {
    const sessionUrl = await getWebappSessionUrl(workerId);
    if (sessionUrl) {
      const slackMessage = `${message} (<${sessionUrl}|*Web UI*>)`;
      await sendMessageToSlack(slackMessage);
    } else {
      await sendMessageToSlack(message);
    }
  } else {
    await sendMessageToSlack(message);
  }
};

/**
 * Convert a timestamp (ms since epoch) into a zero-padded SK string matching the
 * DDB message table's sort key format. Used for range queries (e.g. "all messages
 * since X ms ago") that exploit DDB's lexicographic ordering of the zero-padded
 * 15-char SK.
 */
export const messageSKFromTimestamp = (timestampMs: number): string => String(timestampMs).padStart(15, '0');

/**
 * Retrieve all messages for a session created at or after `sinceMs` (epoch ms).
 * Uses pagination to collect all items from the DDB query. Useful for dedup
 * windows and recent-history lookups.
 */
export const getRecentMessages = async (workerId: string, sinceMs: number): Promise<MessageItem[]> => {
  const cutoff = messageSKFromTimestamp(Math.max(0, Math.floor(sinceMs)));
  const items: MessageItem[] = [];
  const paginator = paginateQuery(
    {
      client: ddb,
    },
    {
      TableName,
      KeyConditionExpression: 'PK = :pk AND SK >= :cutoff',
      ExpressionAttributeValues: {
        ':pk': `message-${workerId}`,
        ':cutoff': cutoff,
      },
    }
  );
  for await (const page of paginator) {
    if (page.Items == null) continue;
    items.push(...(page.Items as MessageItem[]));
  }
  return items;
};

/**
 * Return the SK (sort key) of the most recent message for a worker/session,
 * or `undefined` when the session has no messages yet. SKs are zero-padded
 * fixed-width millisecond timestamps, so the largest SK is the newest message.
 */
export const getLatestMessageSK = async (workerId: string): Promise<string | undefined> => {
  const res = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `message-${workerId}`,
      },
      ScanIndexForward: false, // newest (largest SK) first
      Limit: 1,
      ProjectionExpression: 'SK',
    })
  );
  return res.Items?.[0]?.SK as string | undefined;
};

/**
 * Overwrite the `messageType` attribute of an already-persisted message.
 */
export const updateMessageType = async (workerId: string, messageSK: string, messageType: string) => {
  await ddb.send(
    new UpdateCommand({
      TableName,
      Key: {
        PK: `message-${workerId}`,
        SK: messageSK,
      },
      UpdateExpression: 'SET messageType = :messageType',
      ExpressionAttributeValues: {
        ':messageType': messageType,
      },
    })
  );
};
