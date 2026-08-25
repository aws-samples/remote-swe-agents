/**
 * RemoteSweBedrockModel — a Strands `Model` that wraps remote-swe's bedrockConverse
 * ================================================================================
 * The SDK's stock `BedrockModel` reproduces NONE of remote-swe's
 * Bedrock-specific machinery (multi-account key rotation, region/CRI-profile
 * distribution, ultrathink→thinkingBudget, maxTokens doubling, trackTokenUsage,
 * throttle p-retry). So the Bedrock migration drives the Strands `Agent` loop
 * with THIS custom `Model` whose `stream()` calls the existing `bedrockConverse`
 * and translates the (non-streaming) `ConverseResponse` into the `ModelStreamEvent`
 * sequence the SDK's `streamAggregated()` consumes.
 *
 * `bedrockConverse` is non-streaming (returns a full message), so `stream()`
 * synthesises a coarse event stream: messageStart → per-block (start? → single
 * delta → stop) → messageStop(stopReason) → metadata(usage). `streamAggregated()`
 * re-assembles this into the same `{message, stopReason, metadata}` the loop
 * expects. Token usage flows through the standard `ModelMetadataEvent.usage`
 * channel, so the cost hook consumes it there.
 *
 * ## GAP LIST (historical — tracked before this model became the live path)
 *  - middle-out filtering + cachePoint insertion inside stream(): per-call
 *  middle-out via getItems sidecar + dual cachePoint (firstCachePoint /
 *  secondCachePoint) + system cachePoint (between prompt and envBlock) +
 *  toolConfig cachePoint.
 *  - Throttle + maxTokens retry: pRetry (retries:100, 1-5s backoff) wraps
 *  bedrockConverse inside stream(). Handles ThrottlingException (retry with
 *  account rotation) and max_tokens (retry with incremented
 *  maxTokensExceededCount for token-doubling). The retry boundary is inside
 *  stream(), below the Agent loop, so hooks never see retried partial
 *  responses.
 *  - thinkingBudget returned by bedrockConverse and reasoningContent
 *  (thinking) blocks are surfaced as reasoning deltas.
 *  - assistant-prefill / long-context beta handling is inside bedrockConverse
 *  (preserved).
 *
 * Wired into the live Bedrock path via `bedrockStrandsAgentLoop`.
 */
import { Model, type StreamOptions, type ModelStreamEvent } from '@strands-agents/sdk';
import type { Message as StrandsMessage } from '@strands-agents/sdk';
import type {
  ContentBlock as BedrockContentBlock,
  ConverseCommandInput,
  Message as BedrockMessage,
} from '@aws-sdk/client-bedrock-runtime';
import { ThrottlingException } from '@aws-sdk/client-bedrock-runtime';
import pRetry from 'p-retry';
import { bedrockConverse, middleOutFiltering, noOpFiltering } from '@remote-swe-agents/agent-core/lib';
import type { ModelType } from '@remote-swe-agents/agent-core/schema';
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';
import { strandsToBedrockMessage, type ConverterS3Context } from './message-converter';

export interface RemoteSweBedrockModelConfig {
  /** remote-swe ModelType (e.g. a model id string understood by bedrockConverse). */
  modelId?: string;
  /** ModelType(s) passed to bedrockConverse (fallback distribution list). */
  modelTypes: ModelType[];
  /** workerId for token-usage tracking inside bedrockConverse/trackTokenUsage. */
  workerId: string;
  /** context for image block conversion. */
  s3?: ConverterS3Context;
  /**
   * Dynamic per-turn environment block. Placed AFTER the system prompt
   * cachePoint so it does not invalidate the cached prefix on every turn.
   */
  environmentBlock?: string;
  /**
   * §3.4: per-call middle-out filtering. When provided, stream() evaluates
   * item token counts each call and applies middleOutFiltering if threshold exceeded.
   * Uses the live items array (seedItems + appendedItems from hooks).
   */
  getItems?: () => MessageItem[];
  /** Token threshold for middle-out (typically maxInputTokens * 0.95). */
  tokenThreshold?: number;
  /** Expected delta between SDK messages count and items count (empty-content seed filter count). */
  expectedDelta?: number;
}

/** Map a Bedrock stopReason to the Strands StopReason union. Exported for tests. */
export function mapBedrockStopReason(sr: string | undefined): string {
  switch (sr) {
    case 'tool_use':
      return 'toolUse';
    case 'end_turn':
      return 'endTurn';
    case 'max_tokens':
      return 'maxTokens';
    case 'stop_sequence':
      return 'stopSequence';
    case 'content_filtered':
      return 'contentFiltered';
    case 'guardrail_intervened':
      return 'guardrailIntervened';
    default:
      return 'endTurn';
  }
}

/**
 * Synthesise the ModelStreamEvent sequence for one already-complete Bedrock
 * assistant message. Coarse-grained: one delta per content block.
 */
export function* synthesizeStream(
  message: BedrockMessage,
  stopReason: string,
  usage:
    | { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number }
    | undefined
): Generator<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' } as ModelStreamEvent;

  const content = (message.content ?? []) as BedrockContentBlock[];
  for (const block of content) {
    if ('text' in block && typeof block.text === 'string') {
      yield { type: 'modelContentBlockStartEvent' } as ModelStreamEvent;
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: block.text },
      } as ModelStreamEvent;
      yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
    } else if ('toolUse' in block && block.toolUse) {
      const tu = block.toolUse;
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: tu.name ?? '', toolUseId: tu.toolUseId ?? '' },
      } as ModelStreamEvent;
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(tu.input ?? {}) },
      } as ModelStreamEvent;
      yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
    } else if ('reasoningContent' in block && block.reasoningContent) {
      const rt = block.reasoningContent.reasoningText;
      yield { type: 'modelContentBlockStartEvent' } as ModelStreamEvent;
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'reasoningContentDelta',
          ...(typeof rt?.text === 'string' ? { text: rt.text } : {}),
          ...(typeof rt?.signature === 'string' ? { signature: rt.signature } : {}),
        },
      } as ModelStreamEvent;
      yield { type: 'modelContentBlockStopEvent' } as ModelStreamEvent;
    }
    // Other block kinds are not produced by the assistant turn; skip.
  }

  yield { type: 'modelMessageStopEvent', stopReason: mapBedrockStopReason(stopReason) } as ModelStreamEvent;

  if (usage) {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    yield {
      type: 'modelMetadataEvent',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(usage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
        ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
      },
    } as ModelStreamEvent;
  }
}

/** Sentinel error to signal max_tokens retry within pRetry. */
class MaxTokensRetryError extends Error {
  constructor() {
    super('max_tokens exceeded, retrying with doubled maxTokens');
    this.name = 'MaxTokensRetryError';
  }
}

export class RemoteSweBedrockModel extends Model<RemoteSweBedrockModelConfig> {
  private config: RemoteSweBedrockModelConfig;
  // Dual cachePoint state (legacy L244/L285-295 port).
  // firstCachePoint anchors the "stable prefix" boundary; secondCachePoint
  // tracks the latest message. Both receive a cachePoint marker each call.
  private _firstCachePoint: number | undefined;

  constructor(config: RemoteSweBedrockModelConfig) {
    super();
    this.config = config;
  }

  updateConfig(modelConfig: RemoteSweBedrockModelConfig): void {
    this.config = { ...this.config, ...modelConfig };
  }

  getConfig(): RemoteSweBedrockModelConfig {
    return this.config;
  }

  async *stream(messages: StrandsMessage[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    // §3.4: Per-call middle-out filtering (legacy L263-285 port).
    // When getItems is configured, evaluate item token counts each call.
    // If threshold exceeded, apply middleOutFiltering and use its messages
    // directly (preserves pair integrity + UI-type filtering).
    let bedrockMessages: BedrockMessage[];

    if (this.config.getItems && this.config.tokenThreshold) {
      const items = this.config.getItems();
      const totalTokenCount = items.reduce((sum, item) => sum + item.tokenCount, 0);
      const threshold = this.config.tokenThreshold;

      const result =
        totalTokenCount > threshold ? await middleOutFiltering(items, threshold) : await noOpFiltering(items);

      if (totalTokenCount > threshold) {
        console.log(
          `[RemoteSweBedrockModel] Applying middle-out during agent turn. Total tokens: ${totalTokenCount}, threshold: ${threshold}`
        );
        // After middle-out, both cachePoints reset to last message (legacy L277-278)
        this._firstCachePoint = result.messages.length - 1;
      }

      // Dual cachePoint insertion on messages (legacy L285-295 port).
      // firstCachePoint = stable prefix anchor; secondCachePoint = last message.
      const secondCachePoint = result.messages.length - 1;
      if (this._firstCachePoint === undefined) {
        // Initial: target 3 positions from end for prefix caching (legacy L244)
        this._firstCachePoint = result.messages.length > 2 ? result.messages.length - 3 : result.messages.length - 1;
      }
      for (const cp of new Set([this._firstCachePoint, secondCachePoint])) {
        const message = result.messages[cp];
        if (message?.content) {
          message.content = [...message.content, { cachePoint: { type: 'default' } }];
        }
      }
      this._firstCachePoint = secondCachePoint;

      bedrockMessages = result.messages;

      // Divergence guard — agent.messages and items should stay in sync.
      // expectedDelta accounts for empty-content seed items filtered during conversion.
      const itemCount = items.length;
      const sdkMsgCount = messages.length;
      const expectedDelta = this.config.expectedDelta ?? 0;
      if (Math.abs(sdkMsgCount - itemCount - expectedDelta) >= 1) {
        console.error(
          `[RemoteSweBedrockModel] DIVERGENCE: agent.messages=${sdkMsgCount} vs items=${itemCount} (expected delta=${expectedDelta}, actual=${sdkMsgCount - itemCount})`
        );
      }
    } else {
      // Fallback: convert Strands messages directly (no filtering)
      bedrockMessages = messages.map((m) => strandsToBedrockMessage(m.toJSON(), this.config.s3));
    }

    // Build the ConverseCommandInput. systemPrompt/toolSpecs come from options.
    // System array has cachePoint between static prompt and environmentBlock.
    // Guard: only insert system cachePoint if there's a preceding text block.
    const system: ConverseCommandInput['system'] = [];
    if (options?.systemPrompt) {
      const sp = options.systemPrompt;
      if (typeof sp === 'string') system.push({ text: sp });
    }
    if (system.length > 0) {
      system.push({ cachePoint: { type: 'default' } } as any);
    }
    if (this.config.environmentBlock) {
      system.push({ text: this.config.environmentBlock });
    }

    const toolConfig =
      options?.toolSpecs && options.toolSpecs.length > 0
        ? ({
            tools: [
              ...options.toolSpecs.map((s) => ({
                toolSpec: {
                  name: s.name,
                  description: s.description,
                  inputSchema: { json: s.inputSchema ?? { type: 'object', properties: {} } },
                },
              })),
              { cachePoint: { type: 'default' } },
            ],
          } as ConverseCommandInput['toolConfig'])
        : undefined;

    const input: Omit<ConverseCommandInput, 'modelId'> = {
      messages: bedrockMessages,
      ...(system.length > 0 ? { system } : {}),
      ...(toolConfig ? { toolConfig } : {}),
    };

    // + pRetry around bedrockConverse matching legacy agentLoop
    // (retries: 100, minTimeout: 1000, maxTimeout: 5000).
    // Retries on ThrottlingException (account rotation happens inside
    // bedrockConverse) and on max_tokens (with maxTokensExceededCount doubling).
    let maxTokensExceededCount = 0;

    const response = await pRetry(
      async () => {
        const { response: converseResponse, thinkingBudget } = await bedrockConverse(
          this.config.workerId,
          this.config.modelTypes,
          input,
          maxTokensExceededCount
        );

        // Store detected budget for downstream consumption
        this.lastThinkingBudget = thinkingBudget;

        if (converseResponse.stopReason === 'max_tokens') {
          maxTokensExceededCount += 1;
          console.log(`[RemoteSweBedrockModel] retrying... maxTokenExceeded ${maxTokensExceededCount} time(s)`);
          throw new MaxTokensRetryError();
        }

        return converseResponse;
      },
      {
        retries: 100,
        minTimeout: 1000,
        maxTimeout: 5000,
        signal: options?.cancelSignal,
        onFailedAttempt: (error) => {
          if (error instanceof ThrottlingException) {
            console.log(`[RemoteSweBedrockModel] retrying throttle... ${error.message}`);
          }
        },
        shouldRetry: (error) => {
          // Only retry throttle and max_tokens; abort on anything else
          return error instanceof ThrottlingException || error instanceof MaxTokensRetryError;
        },
      }
    );

    const message = response.output?.message ?? { role: 'assistant', content: [] };
    // Track usage for cost/contextUsagePercentage
    if (response.usage) {
      const u = response.usage;
      this._lastCallUsage = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: u.cacheWriteInputTokens ?? 0,
      };
      this._accumulatedUsage.inputTokens += this._lastCallUsage.inputTokens;
      this._accumulatedUsage.outputTokens += this._lastCallUsage.outputTokens;
      this._accumulatedUsage.cacheReadInputTokens += this._lastCallUsage.cacheReadInputTokens;
      this._accumulatedUsage.cacheWriteInputTokens += this._lastCallUsage.cacheWriteInputTokens;
    }
    yield* synthesizeStream(message, response.stopReason ?? 'end_turn', response.usage);
  }

  /** Last detected thinkingBudget from bedrockConverse (for downstream hooks). */
  get detectedThinkingBudget(): number | undefined {
    return this.lastThinkingBudget;
  }
  private lastThinkingBudget: number | undefined;

  /** Accumulated token usage across all model calls in this turn (for cost tracking). */
  get accumulatedUsage(): {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
  } {
    return { ...this._accumulatedUsage };
  }
  /** Usage from the most recent successful model call (for contextUsagePercentage). */
  get lastCallUsage():
    | { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheWriteInputTokens: number }
    | undefined {
    return this._lastCallUsage;
  }
  private _accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  private _lastCallUsage:
    | { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheWriteInputTokens: number }
    | undefined;
}
