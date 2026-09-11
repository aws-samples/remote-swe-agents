import { Message } from '@aws-sdk/client-bedrock-runtime';
import { PersistedToolResult, PersistedToolUse, ToolEventSink, ToolResultEmit, ToolUseEmit } from './types';
import { saveToolResultMessage, saveToolUseMessage } from '../messages';
import { sendWebappEvent } from '../events';

/**
 * Default production wiring of {@link ToolEventSink}.
 *
 * Persist:  saveToolUseMessage / saveToolResultMessage  (DynamoDB)
 * Emit:     sendWebappEvent({ type: 'toolUse' | 'toolResult' })  (AppSync/EB)
 *
 * This is exactly what the current Bedrock loop does inline; extracting it
 * lets Kiro reuse the same plumbing and keeps the observable behaviour
 * identical for Bedrock callers.
 */
export const defaultToolEventSink: ToolEventSink = {
  async persistToolUseMessage(
    workerId: string,
    message: Message,
    metadata?: { outputTokenCount?: number; thinkingBudget?: number }
  ): Promise<PersistedToolUse> {
    const saved = await saveToolUseMessage(
      workerId,
      message,
      metadata?.outputTokenCount ?? 0,
      metadata?.thinkingBudget
    );
    return { SK: saved.SK, item: saved };
  },

  async persistToolResultMessage(workerId: string, message: Message, parentSK: string): Promise<PersistedToolResult> {
    const saved = await saveToolResultMessage(workerId, message, parentSK);
    return { SK: saved.SK, item: saved };
  },

  async emitToolUseEvent(workerId: string, payload: ToolUseEmit): Promise<void> {
    await sendWebappEvent(workerId, {
      type: 'toolUse',
      toolName: payload.toolName,
      toolUseId: payload.toolUseId,
      input: typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input ?? {}),
      thinkingBudget: payload.thinkingBudget,
      reasoningText: payload.reasoningText,
      messageSK: payload.messageSK,
    });
  },

  async emitToolResultEvent(workerId: string, payload: ToolResultEmit): Promise<void> {
    await sendWebappEvent(workerId, {
      type: 'toolResult',
      toolName: payload.toolName,
      toolUseId: payload.toolUseId,
      output: payload.output,
      ...(payload.imageKeys && payload.imageKeys.length > 0 ? { imageKeys: payload.imageKeys } : {}),
    });
  },
};
