import { WebClient } from '@slack/web-api';
import { getConversationHistory, getTokenUsage } from '../util/history';
import { calculateCost } from '../util/cost';
import { Message } from '@aws-sdk/client-bedrock-runtime';
import * as fs from 'fs';
import * as os from 'os';
import { getSessionIdFromSlack } from '../util/session-map';

export async function handleDumpHistory(
  event: {
    text: string;
    user?: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    blocks?: any[];
    files?: any[];
  },
  client: WebClient
): Promise<void> {
  const workerId = await getSessionIdFromSlack(event.channel, event.thread_ts ?? event.ts, false);
  const [history, tokenUsage] = await Promise.all([getConversationHistory(workerId), getTokenUsage(workerId)]);

  const tempFile = os.tmpdir() + `/worker_${workerId}_history.txt`;
  const stringifyMessage = (
    message: {
      timestamp: string;
    } & Message
  ) => {
    const stripAnsiSequences = (text: string) => {
      return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
    };

    const prefix = `[${message.timestamp}] ${message.role}:`;
    const content = message.content
      ?.map((c: any) => {
        if (c.text != null) {
          return stripAnsiSequences(c.text);
        } else if (c.toolUse != null) {
          return stripAnsiSequences(
            `<TOOL USE: ${c.toolUse?.name} ${c.toolUse.toolUseId}> ${JSON.stringify(c.toolUse.input)}`
          );
        } else if (c.toolResult != null) {
          return stripAnsiSequences(`<TOOL RESULT: ${c.toolResult.toolUseId}> ${c.toolResult.content?.[0].text}`);
        } else if (c.image != null) {
          return `[IMAGE: ${c.image.source.s3Key}]`;
        }
      })
      .join('\n\n');
    return `${prefix} ${content}`;
  };

  const tokenSummary = tokenUsage
    .map((item) => {
      const cost = calculateCost(
        item.SK,
        item.inputToken,
        item.outputToken,
        item.cacheReadInputTokens,
        item.cacheWriteInputTokens
      );
      return (
        `Model: ${item.SK}\n` +
        `Input tokens: ${item.inputToken}\n` +
        `Output tokens: ${item.outputToken}\n` +
        `Cache Read tokens: ${item.cacheReadInputTokens}\n` +
        `Cache Write tokens: ${item.cacheWriteInputTokens}\n` +
        `Cost: ${cost.toFixed(4)} USD`
      );
    })
    .join('\n\n');

  const totalCost = tokenUsage.reduce((acc, item) => {
    return (
      acc +
      calculateCost(item.SK, item.inputToken, item.outputToken, item.cacheReadInputTokens, item.cacheWriteInputTokens)
    );
  }, 0);

  const totalInputTokens = tokenUsage.reduce((acc, item) => acc + item.inputToken, 0);
  const totalOutputTokens = tokenUsage.reduce((acc, item) => acc + item.outputToken, 0);
  const totalCacheReadTokens = tokenUsage.reduce((acc, item) => acc + item.cacheReadInputTokens, 0);
  const totalCacheWriteTokens = tokenUsage.reduce((acc, item) => acc + item.cacheWriteInputTokens, 0);

  const historyText =
    `=== Token Usage Summary ===\n` +
    `Total Input Tokens: ${totalInputTokens}\n` +
    `Total Output Tokens: ${totalOutputTokens}\n` +
    `Cache Read tokens: ${totalCacheReadTokens}\n` +
    `Cache Write tokens: ${totalCacheWriteTokens}\n` +
    `Total Cost: ${totalCost.toFixed(4)} USD\n\n` +
    `=== Per Model Breakdown ===\n` +
    `${tokenSummary}\n\n` +
    `=== Conversation History ===\n` +
    history.map((msg) => stringifyMessage(msg)).join('\n');

  fs.writeFileSync(tempFile, historyText);
  const uploadResult = await client.files.uploadV2({
    channel_id: event.channel,
    thread_ts: event.thread_ts ?? event.ts,
    file: fs.readFileSync(tempFile),
    filename: `worker_${workerId}_history.txt`,
    initial_comment: `Message history for worker ${workerId}`,
  });
  fs.unlinkSync(tempFile);
}
