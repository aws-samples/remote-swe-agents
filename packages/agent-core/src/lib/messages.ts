import { Message } from '@aws-sdk/client-bedrock-runtime';
import { PutCommand, UpdateCommand, QueryCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';
import sharp from 'sharp';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ddb, TableName } from './aws/ddb';
import { writeBytesToKey, getBytesFromKey, BucketName } from './aws/s3';
import { sendWebappEvent } from './events';
import { sendMessageToSlack } from './slack';
import { getWebappSessionUrl } from './webapp-origin';
import { updateSessionLastMessage } from './sessions';
import {
  MessageItem,
  INTERNAL_ERROR_MESSAGE_TYPE,
  RETRIGGER_GIVEUP_MESSAGE_TYPE,
  CANCELLED_TURN_MESSAGE_TYPE,
} from '../schema';

// Maximum input token count before applying middle-out strategy
export const MAX_INPUT_TOKEN = 80_000;

import { ensureImageWithinBounds } from './image-resize';
export { ensureImageWithinBounds };

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
  // Ordering guard: the end-of-turn assistant message must never sort
  // BEFORE an intra-turn message (a `sendMessageToAgent` / `sendMessageToUser`
  // emitted earlier in the same turn). Because every SK is `Date.now()` at
  // write time, a delayed final write (kiro-cli tool round-trip, retrigger
  // sleep, DDB latency) could otherwise take a timestamp LARGER than an
  // intermediate whose own write was delayed — or, on a resurrection turn, an
  // intermediate re-sent later than the final report (observed live: an
  // in-progress status update landed 41s AFTER its own completion report).
  // When `ensureAfterSK` is supplied we clamp the SK to be strictly greater
  // than it, preserving intra-turn order. Callers pass the max SK observed
  // in the session so far.
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

/**
 * Fetch the maximum (latest) SK currently stored for a session, or `undefined`
 * when the session has no messages yet. Used by the end-of-turn persist path
 * to clamp the final assistant message's SK so it sorts after every intra-turn
 * message (the ordering guard above). Reads ALL message types (`includeAll`) because
 * communicationLog mirrors of outgoing agent messages also occupy SK slots and
 * must be ordered before the final reply.
 *
 * Implemented as a single DynamoDB `Query` with `ScanIndexForward: false` +
 * `Limit: 1`, which returns only the row with the largest SK — an O(1) read
 * regardless of session length. SKs are zero-padded fixed-width millisecond
 * timestamps (`String(Date.now()).padStart(15, '0')`), so DynamoDB's
 * lexicographic SK ordering coincides with numeric ordering and the last item
 * is genuinely the max SK. We intentionally do NOT filter by `messageType`
 * here (no `includeAll` equivalent): every persisted row — including the
 * communicationLog mirrors of outgoing agent messages — occupies an SK slot
 * and must be considered when clamping the final reply's SK.
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
 * Format a millisecond epoch timestamp into the zero-padded, fixed-width SK
 * representation the message table uses (`String(ms).padStart(15, '0')`).
 * Exported for unit testing so callers / tests don't re-derive the padding.
 */
export const messageSKFromTimestamp = (timestampMs: number): string => String(timestampMs).padStart(15, '0');

/**
 * Fetch only the messages written at or after `sinceMs` (a millisecond epoch
 * timestamp), using a DynamoDB `SK >= :cutoff` KeyCondition so the read is
 * bounded to the recent window instead of scanning the full session history.
 *
 * Used by the agent-messaging dedup look-back, which only ever cares about the
 * last `DEFAULT_DEDUP_WINDOW_MS` (~5 min) of outgoing messages. Returns ALL
 * message types (no `communicationLog` / internalError filtering) because the
 * dedup look-back inspects the sender's own `communicationLog` mirror rows; the
 * caller applies its own `messageType` / sender / target filter in memory.
 *
 * SKs are zero-padded fixed-width millisecond timestamps, so a lexicographic
 * `SK >= cutoff` comparison coincides with the numeric `timestamp >= sinceMs`
 * window. A negative `sinceMs` is clamped to 0 so the cutoff is always a valid
 * 15-char SK.
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

export interface GetConversationHistoryOptions {
  /**
   * When true, return all messages without filtering.
   * When false/omitted, messages with `messageType === 'communicationLog'` are excluded.
   *
   * `communicationLog` items are sibling-to-sibling agent-messaging entries that are
   * persisted in the parent session's DynamoDB history purely for UI display (so the
   * webapp can reconstruct the sibling communication log after a page reload). They
   * must NOT be included when building LLM context, because on a PM-style parent with
   * many children they would balloon the context and cause middleOutFiltering to silently
   * drop the user's actual messages.
   *
   * Rule of thumb:
   * - LLM-facing callers (worker agent loop, orchestrator, take-over, etc.) → omit / false
   * - UI-facing callers (webapp pages, API routes that render history, dump-history) → true
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
          item.messageType !== 'communicationLog' &&
          item.messageType !== 'userDeliveryLog' &&
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
  // Belt-and-suspenders guard: `communicationLog` / `userDeliveryLog` are UI-only
  // mirrors and the internal-only markers (`internalError`, `retriggerGiveup`)
  // must never enter an LLM context. They are already filtered out by
  // `getConversationHistory` by default, but if a future caller accidentally passes
  // `{ includeAll: true }` to a history fetch that feeds an LLM, the tokenCount=0 on these
  // rows would silently inflate the real context and mislead this function. Drop them
  // unconditionally here so the LLM path is safe by construction.
  items = items.filter(
    (item) =>
      item.messageType !== 'communicationLog' &&
      item.messageType !== 'userDeliveryLog' &&
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

/**
 * Options for `noOpFiltering`.
 *
 * `forUi`: when true, `postProcessMessageContent` is invoked in UI mode, which
 * preserves the original `image.source.s3Key` / `file.source.s3Key` blocks and
 * does NOT download the referenced bytes from S3. This is what the webapp
 * needs to render attachments — `<img>` and download links are produced from
 * the s3Key via pre-signed URLs on the client side. Loading the bytes here is
 * not just wasteful; for multi-GB attachments it can OOM the Lambda hosting
 * the webapp (1.5 GiB ZIP + Node Buffer overhead → >3 GiB peak heap, killed
 * by the 1769 MB Lambda memory cap, response stream truncated, browser shows
 * `ERR_CONTENT_DECODING_FAILED`).
 *
 * The default (`forUi` omitted / false) preserves the legacy LLM-facing
 * behaviour: image bytes are fetched, file paths are flattened to a `text`
 * block referring to the local-FS copy. Worker callers (agent loop, take-over,
 * etc.) MUST keep using the default; they need the bytes for Bedrock Converse
 * and the local-FS path for shell tools.
 */
export interface NoOpFilteringOptions {
  forUi?: boolean;
}

export const noOpFiltering = async (items: MessageItem[], options: NoOpFilteringOptions = {}) => {
  let totalTokenCount = items.reduce((sum: number, item) => sum + item.tokenCount, 0);
  return { items, totalTokenCount, messages: await itemsToMessages(items, options.forUi) };
};

const itemsToMessages = async (items: MessageItem[], forUi = false) => {
  return (await Promise.all(
    items.map(async (item) => ({
      role: item.role,
      content: await postProcessMessageContent(item.content, forUi),
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
          // W-1' guard: a zero-length image (e.g. an MCP tool returning empty image
          // data) must be neutralized, not merely skipped. structuredClone +
          // JSON.stringify turns an empty Uint8Array into `{}`, which survives a
          // history load as a truthy image block and gets re-sent to the model on
          // every subsequent turn (cascading "Could not process image"). Replace the
          // whole image block with a benign text marker so nothing empty is persisted.
          if ((bytes instanceof Uint8Array || Buffer.isBuffer(bytes)) && bytes.length === 0) {
            delete (cc as { image?: unknown }).image;
            (cc as { text?: string }).text = '[empty image result skipped]';
            continue;
          }
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
const toolResultImageCache: Record<string, { bytes: Uint8Array; format: string }> = {};

/**
 * NOTE: originalPath now contains the resized (\<\=1568px) image, not the raw S3 original.
 * The full-size original is only in S3; local disk always has the clamped version.
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
 * Derive the Bedrock-compatible image `format` value from an S3 key's
 * file extension (returned by `s3Key.split('.').pop()` — not including
 * the leading dot). Used by `postProcessMessageContent` to normalise
 * attached image uploads as they are rehydrated from DynamoDB.
 *
 * Bedrock Converse's `image.format` enum is `'png' | 'jpeg' | 'gif' |
 * 'webp'`; `.jpg` uploads must be rewritten to `'jpeg'` or the Converse
 * call fails validation. Extensions not in the whitelist fall back to
 * `'webp'` — sharp can encode any decodable input to webp and Bedrock
 * accepts it, so this prevents a permanent 400 from non-standard keys.
 *
 * Exported for unit testing.
 */
const VALID_IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp']);

export const imageFormatFromExtension = (ext: string): string => {
  const lower = ext.toLowerCase();
  const normalised = lower === 'jpg' ? 'jpeg' : lower;
  return VALID_IMAGE_FORMATS.has(normalised) ? normalised : 'webp';
};

/**
 * Defensively parse a stored `content` string into an array of ContentBlocks.
 *
 * The normal write path (`preProcessMessageContent`) always persists a
 * JSON-stringified ContentBlock array, so `JSON.parse` succeeds and returns an
 * array in practice. This helper is defence in depth: a malformed legacy row,
 * a future code path, or a hand-edited item could store plain text (or a
 * non-array JSON value) in `content`. In that case `JSON.parse` would throw an
 * unhandled server-side exception and tank the whole turn / page render.
 *
 * Instead we fall back to treating the raw string as a single `text` block,
 * mirroring the tolerant parsing already used elsewhere (the dedup look-back in
 * agent-messaging.ts and the webapp `extractUserMessage`). A parsed-but-non-
 * array value (e.g. a bare JSON string/number) is likewise wrapped as a single
 * text block so downstream `for (const c of ...)` iteration is always safe.
 *
 * Exported for unit testing.
 */
export const parseContentBlocks = (content: string): any[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [{ text: content }];
  }
  if (!Array.isArray(parsed)) {
    return [{ text: content }];
  }
  return parsed;
};

/**
 * process message content after getting it from DB
 *
 * `forUi`: when true, image/file blocks that reference an S3 key are passed
 * through unchanged instead of being rehydrated into bytes / local-FS paths.
 * This is the path taken by webapp UI callers (`page.tsx`, `route.ts`) which
 * only need the s3Key + fileName to render `<img>` previews and download
 * links via pre-signed URLs. Skipping the S3 fetch is critical: a single
 * multi-GB attachment in the history would otherwise be loaded into the
 * Lambda's heap on every page render and OOM the function (1769 MB cap).
 *
 * The default (`forUi = false`) preserves the LLM/worker contract: bytes are
 * fetched, images are normalised to a Bedrock-Converse-compatible format,
 * non-image files are flattened to a `text` block pointing at a local-FS
 * copy so shell tools can read them.
 *
 * `isTopLevel`: when true (the default), user-attached images are flattened to
 * text blocks with S3 URI + local paths. When false (recursive toolResult
 * processing), images are rehydrated as image bytes so Bedrock can render them
 * inline (e.g. readLocalImage results, screenshots). This prevents the
 * "infinite read loop" where flattened toolResult images produce another text
 * instruction to "read the preview path".
 */
const postProcessMessageContent = async (content: string, forUi = false, isTopLevel = true) => {
  const contentArray = parseContentBlocks(content);
  const flattenedArray = [];

  for (const c of contentArray) {
    if (typeof c.image?.source?.s3Key == 'string') {
      if (forUi) {
        flattenedArray.push(c);
        continue;
      }
      const s3Key = c.image.source.s3Key as string;
      if (isTopLevel) {
        try {
          const { previewPath, fileName, s3Uri } = await materializeImageBlock(s3Key);
          flattenedArray.push({
            text:
              `the image "${fileName}" is available as a resized preview at ${previewPath} (original: ${s3Uri})\n` +
              `to view this image, use the readLocalImage tool on the preview path`,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[messages] Failed to process image ${s3Key}: ${msg}`);
          flattenedArray.push({
            text: `[image attachment, s3Key: ${s3Key}, s3Uri: s3://${BucketName}/${s3Key}, note: failed-to-fetch]`,
          });
        }
      } else {
        try {
          if (s3Key in toolResultImageCache) {
            const cached = toolResultImageCache[s3Key]!;
            flattenedArray.push({
              image: {
                format: cached.format,
                source: { bytes: cached.bytes },
              },
            });
          } else {
            const bytes = await getBytesFromKey(s3Key);
            const format = imageFormatFromExtension(s3Key.split('.').pop() || 'png');
            const clamped = await ensureImageWithinBounds(bytes, { format });
            toolResultImageCache[s3Key] = { bytes: clamped, format };
            flattenedArray.push({
              image: {
                format,
                source: { bytes: clamped },
              },
            });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[messages] Failed to rehydrate toolResult image ${s3Key}: ${msg}`);
          flattenedArray.push({
            text: `[image in tool result, s3Key: ${s3Key}, note: failed-to-fetch]`,
          });
        }
      }
    } else if (typeof c.file?.source?.s3Key == 'string') {
      if (forUi) {
        flattenedArray.push(c);
        continue;
      }
      const s3Key = c.file.source.s3Key as string;
      const { localPath, fileName } = await materializeFileBlock(s3Key, c.file.fileName);

      flattenedArray.push({
        text: `the file "${fileName}" is stored locally on ${localPath}`,
      });
    } else if (c.toolResult?.content != null) {
      c.toolResult.content = await postProcessMessageContent(JSON.stringify(c.toolResult.content), forUi, false);
      flattenedArray.push(c);
    } else {
      flattenedArray.push(c);
    }
  }

  return flattenedArray;
};

/**
 * Deliver an assistant message to Slack and (optionally) the webapp real-time
 * channel. When `messageSK` is provided the message is treated as a rendered,
 * persisted bubble: the session's list-preview (`lastMessage`) and ordering
 * timestamp (`lastMessageAt`) are updated in DDB and a `lastMessageUpdate`
 * consistency signal is emitted so the webapp can self-recover from dropped
 * real-time events.
 *
 * @param messageSK - Pass ONLY when the message has already been persisted to
 *   DDB as a conversation-history item (i.e. it will appear as a chat bubble
 *   after a page refresh). Omitting this parameter disables preview/ordering
 *   updates and the drop-recovery signal — correct for transient lifecycle
 *   notifications (sleep, termination, ack) that must NOT reorder the session
 *   list.
 */
export const sendSystemMessage = async (
  workerId: string,
  message: string,
  appendWebappUrl: boolean = false,
  skipWebappEmit: boolean = false,
  messageSK?: string
) => {
  // Webapp message emit is gated on `skipWebappEmit` so callers that have
  // already delivered the same text to the webapp through another channel
  // (e.g. the Kiro tool-boundary text flush in `kiroAgentLoop`) can avoid
  // creating a duplicate `type:'message'` bubble — the webapp's
  // `SessionPageClient` does not deduplicate assistant messages by content,
  // so a re-emit would surface as a visual duplicate. Slack delivery is
  // NEVER gated by this flag; the Slack channel cannot dedup either, but
  // it has only ONE producer (this function) and so cannot duplicate
  // unless the caller has its own Slack send, which by convention they do
  // not.
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
  // list — the user explicitly rejected sleep/lifecycle events pushing idle
  // sessions above active ones. They also don't survive a page refresh, so
  // the consistency signal (lastMessageUpdate) would find no matching bubble
  // and trigger a useless router.refresh().
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
