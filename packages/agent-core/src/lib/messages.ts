import { Message } from '@aws-sdk/client-bedrock-runtime';
import { PutCommand, UpdateCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';
import sharp from 'sharp';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ddb, TableName } from './aws/ddb';
import { writeBytesToKey, getBytesFromKey } from './aws/s3';
import { sendWebappEvent } from './events';
import { sendMessageToSlack } from './slack';
import { getWebappSessionUrl } from './webapp-origin';
import { MessageItem } from '../schema';

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
  thinkingBudget?: number
) => {
  const item = {
    PK: `message-${workerId}`,
    SK: `${String(Date.now()).padStart(15, '0')}`, // make sure it can be sorted in dictionary order
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

export const getConversationHistory = async (workerId: string) => {
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

  return { items, slackUserId: searchForLastSlackUserId(items) };
};

const searchForLastSlackUserId = (items: MessageItem[]) => {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].slackUserId) {
      return items[i].slackUserId;
    }
  }
};

export const middleOutFiltering = async (items: MessageItem[], maxInputToken = MAX_INPUT_TOKEN) => {
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

export const sendSystemMessage = async (workerId: string, message: string, appendWebappUrl: boolean = false) => {
  // Always send original message to webapp
  await sendWebappEvent(workerId, {
    type: 'message',
    role: 'assistant',
    message,
  });

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
