/**
 * bedrockStrandsAgentLoop — Bedrock backend loop on the Strands Agent
 * =======================================================================
 * Drives a Strands `Agent` with the custom {@link RemoteSweBedrockModel} (which
 * wraps bedrockConverse). This is the live Bedrock backend path:
 * `BedrockBackend.runTurn` routes every Bedrock turn through this loop
 * unconditionally (the former `BEDROCK_USE_STRANDS` selection flag has been
 * retired along with the legacy hand-written loop).
 *
 * Design (DESIGN §3): Strands owns the reason→tool→result iteration; remote-swe
 * concerns are re-homed into (a) the custom Model (Bedrock specifics), (b) the
 * toStrandsTool adapter, and (c) hooks for persistence + emit. Persistence binds
 * to the BATCH-BOUNDARY hooks (BeforeToolsEvent → one toolUse item;
 * AfterToolsEvent → one toolResult item at SK=parentSK+1) so a multi-tool turn
 * cannot collide on SK; per-tool events do webapp emit only.
 * NullConversationManager disables the SDK's sliding window (§3.0); printer off.
 * Cancellation IS wired: ctx.cancellationToken → invoke cancelSignal.
 *
 * ## GAP LIST (historical — tracked before this loop became the live path)
 *  - middle-out / cachePoint (§3.4):
 *  RESOLVED — per-call middle-out filtering in stream() using legacy
 *  middleOutFiltering/noOpFiltering via getItems sidecar. updateMessageTokenCount
 *  wired in BeforeToolsEvent + post-invoke. appendedItems tracks intra-turn
 *  growth for accurate per-call re-evaluation.
 *  CachePoint insertion: RESOLVED — environmentBlock separated from
 *  systemPrompt; passed via model config. RemoteSweBedrockModel.stream()
 *  injects cachePoint in system (between prompt and envBlock), toolConfig,
 *  and dual message positions (verbatim port of the legacy loop: firstCachePoint
 *  for stable prefix + secondCachePoint for latest message, with Set dedup).
 *  - cost + updateSessionCost + updateMessageTokenCount from usage: RESOLVED
 *  — trackTokenUsage + updateSessionCost + contextUsagePercentage +
 *  updateMessageTokenCount all wired. tokenCount is updated on each user
 *  message (initial + each toolResult + final end_turn) after model calls.
 *  - **throttle RETRY:** RESOLVED — pRetry (retries:100, 1-5s backoff)
 *  now wraps bedrockConverse inside RemoteSweBedrockModel.stream(), matching
 *  legacy agentLoop retry semantics. ThrottlingException triggers retry with
 *  account rotation (inside bedrockConverse) + exponential backoff.
 *  - **maxTokens retry:** RESOLVED — max_tokens stopReason triggers
 *  retry with incremented maxTokensExceededCount (bedrockConverse doubles
 *  maxTokens internally). The double-persist guard: retry is below the Agent
 *  boundary so hooks fire only on the final successful response.
 *  - **per-tool webapp emit:** RESOLVED — BeforeToolCallEvent /
 *  AfterToolCallEvent hooks now emit toolUse / toolResult webapp events
 *  with per-tool granularity, including sendMessageToUser special-case.
 *  - **model resolution:** RESOLVED — resolveModelTypes() now uses
 *  resolveModelConfig with the same precedence as legacy agentLoop
 *  (per-message override > user preferences > session > customAgent > defaults).
 *  - skill activation (read /tmp/skills/{id}/SKILL.md → widen tools) via
 *  AfterToolCallEvent + tool re-registration: PARTIALLY RESOLVED — detection
 *  + activatedSkillIds recording is in place. Registry swap (allowedTools
 *  enforcement) deferred: Bedrock-name→kiro-name mapping is unresolved and
 *  main baseline is "never fires" (dead code in legacy Bedrock). Separate
 *  design required for Bedrock allowedTools enforcement.
 *  - repo-knowledge refresh after cloneRepository.
 *  - error taxonomy (errorFeedback / circuit-breaker / permanent-error) and
 *  the agentError willRetry webapp event: RESOLVED — invokeLoop wraps
 *  agent.invoke() with categorizeError + isPermanentError + circuit breaker
 *  (MAX_CONSECUTIVE_ERRORS=3) + errorFeedback injection + sendWebappEvent.
 *  - thinkingBudget threading to persist/emit: RESOLVED — passed to
 *  persistToolUseMessage options + per-tool emit payload + final persist.
 *  Reasoning signature round-trip is handled by the converter.
 *  - **final assistant structure loss:** RESOLVED — the full Strands
 *  lastMessage is converted to Bedrock wire format via strandsToBedrockMessage
 *  (preserving reasoningContent, toolUse, etc.) and persisted with
 *  saveConversationHistory including outputTokenCount and thinkingBudget.
 *  - ctx.environmentBlock injection into the system prompt: RESOLVED —
 *  appended to systemPrompt string when present (legacy appends it as a
 *  separate system block after cachePoint; here it's concatenated since
 *  Strands Agent accepts a single systemPrompt string).
 *  - toolResult multimodal passthrough (toStrandsTool flattens to text).
 *  - **unknown-block history loss:** RESOLVED — bedrockBlockToStrands maps
 *  video/document/guardContent/citations to their native Strands equivalents;
 *  strandsBlockToBedrock maps them back. SDK Message.fromJSON handles all
 *  natively (no opaque passthrough marker). Truly unknown types (audio, etc.)
 *  are silently dropped (safer than turn crash from SDK throw).
 *  - **forceReport timer system:** RESOLVED — renderToolResult wraps all
 *  tool results; forceReport=true after 5min without communication-tool use.
 *  shouldResetReportTimer resets on Send Message To User/Agent, Acknowledge.
 *  Timer state shared via ToolAdapterDeps.forceReportState mutable object.
 *  - **MCP multimodal tool results:** RESOLVED — MCP image content decoded
 *  from base64 and returned as SDK-native ImageBlock via FunctionTool callback.
 *  - AGENT_RUNTIME_ARN missing on stopMyself: observed in E2E logs but cannot
 *  be confirmed as worker-code issue (likely platform payload gap). Known
 *  issue; next observation should add payload logging to confirm.
 *
 * NOT wired into production yet (flag off).
 */
import type { ToolEventSink, TurnContext, TurnResult } from '@remote-swe-agents/agent-core/lib';
import {
  getPreferences,
  sendSystemMessage,
  sendWebappEvent,
  saveConversationHistory,
  updateSessionCost,
  updateMessageTokenCount,
} from '@remote-swe-agents/agent-core/lib';
import { resolveModelConfig } from '@remote-swe-agents/agent-core/lib';
import { persistErrorBubble } from './persist-error-bubble';
import { emptyFinalMessageNotification, normalizeMcpImageFormat } from './index';
import type { Message as BedrockMessage } from '@aws-sdk/client-bedrock-runtime';
import { runInvokeLoop, type InvokeLoopState } from './strands/invoke-loop';
import { computeMessageTokenCount } from './strands/token-attribution';
import {
  Agent,
  NullConversationManager,
  BeforeToolsEvent,
  AfterToolsEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  FunctionTool,
} from '@strands-agents/sdk';
import type { ToolContext } from '@strands-agents/sdk';
import { allTools, isGitHubConfigured, requiredToolNames, gitHubTools } from '@remote-swe-agents/agent-core/tools';
import { EmptyMcpConfig, mcpConfigSchema, modelConfigs, type ModelType } from '@remote-swe-agents/agent-core/schema';
import { RemoteSweBedrockModel } from './strands/remote-swe-bedrock-model';
import { strandsToBedrockMessage, bedrockToStrandsMessage, type ConverterS3Context } from './strands/message-converter';
import {
  toStrandsTool,
  sanitizeToolName,
  mcpContentToSdkBlocks,
  type ToolAdapterDeps,
} from './strands/to-strands-tool';
import { getMcpToolSpecs, tryExecuteMcpTool } from './mcp';

/**
 * Factory: wraps saveConversationHistory to also push the saved item to appendedItems.
 * Exported for testability (must-fix A: real wrapper path must be exercised by tests).
 */
export function makeSaveHistoryDep(
  appendedItems: { SK: string; tokenCount: number; role: string; content: string; messageType: string; PK: string }[],
  persist: typeof saveConversationHistory
) {
  return async (wId: string, msg: BedrockMessage, tc: number, tag: string) => {
    const saved = await persist(wId, msg, tc, tag);
    appendedItems.push(saved);
    return saved;
  };
}

/**
 * Resolve model types using the same precedence as the legacy agentLoop:
 * per-message override > user preferences override > session > customAgent > defaults.
 */
export async function resolveModelTypes(ctx: TurnContext): Promise<ModelType[]> {
  const { session, customAgent, history } = ctx;
  const globalPreferences = await getPreferences();

  // Only the triggering (last user) message's per-message override takes
  // highest priority. Historical message overrides must NOT shadow the
  // session-level model which the user explicitly persisted via the webapp
  // model selector. User preferences go through the proper low-priority
  // channel so they never override the session setting.
  const lastUserMessage = history.filter((i) => i.role === 'user').at(-1);
  const perMessageModel = lastUserMessage?.modelOverride;

  const resolved = resolveModelConfig({
    overrides: perMessageModel ? { modelOverride: perMessageModel as ModelType } : undefined,
    session: session
      ? {
          bedrockDefaultModel: session.bedrockDefaultModel,
          kiroDefaultModel: session.kiroDefaultModel,
          inferenceMode: session.inferenceMode,
        }
      : undefined,
    customAgent: {
      bedrockDefaultModel: customAgent.bedrockDefaultModel,
      defaultModel: customAgent.defaultModel,
    },
    userPreferences: globalPreferences.modelOverride
      ? { bedrockDefaultModel: globalPreferences.modelOverride as ModelType }
      : undefined,
  });
  let modelType = resolved.bedrockModel;
  if (!modelConfigs[modelType]) {
    console.error(`[bedrockStrandsAgentLoop] Unknown model type: ${modelType}. Falling back to default.`);
    modelType = customAgent.bedrockDefaultModel ?? customAgent.defaultModel;
  }
  return [modelType];
}

export const bedrockStrandsAgentLoop = async (ctx: TurnContext, sink: ToolEventSink): Promise<TurnResult> => {
  const { workerId, systemPrompt, customAgent } = ctx;
  const s3: ConverterS3Context = { bucket: process.env.BUCKET_NAME };

  const resolvedTypes = await resolveModelTypes(ctx);
  const model = new RemoteSweBedrockModel({
    workerId,
    modelTypes: resolvedTypes,
    s3,
    environmentBlock: ctx.environmentBlock,
  });

  // --- Tool wiring (parity with legacy agentLoop L175-231) -------------------
  // 1. Parse MCP config from the custom agent
  let mcpConfig = EmptyMcpConfig;
  {
    const { data, error } = mcpConfigSchema.safeParse(JSON.parse(customAgent.mcpConfig));
    if (error) {
      sendSystemMessage(
        workerId,
        `Invalid mcp config: ${error}. Please check the agent configuration for ${customAgent.name}`
      );
    } else {
      mcpConfig = data;
    }
  }

  // 2. Filter tools exactly as the legacy loop does:
  //  - Exclude GitHub tools if GitHub is not configured
  //  - Include tool if useAllTools OR tool is in agent's selected tools OR is required
  const gitHubToolNames = gitHubTools.map((t) => t.name);
  const filteredTools = allTools.filter(
    (tool) =>
      (isGitHubConfigured() || !gitHubToolNames.includes(tool.name)) &&
      (customAgent.useAllTools || customAgent.tools.includes(tool.name) || requiredToolNames.includes(tool.name))
  );

  // 3. Resolve per-turn deps for tool handlers
  const globalPreferences = await getPreferences();
  // forceReport timer state — shared with tool adapters via closure
  const forceReportState = { lastReportedTime: 0, parentSessionId: ctx.session?.parentSessionId };
  const toolDeps: ToolAdapterDeps = {
    workerId,
    globalPreferences,
    cancellationToken: ctx.cancellationToken,
    forceReportState,
  };

  // 4. Convert remote-swe ToolDefinitions → Strands tools via toStrandsTool
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strandsTools = await Promise.all(filteredTools.map((t) => toStrandsTool(t as any, toolDeps)));

  // 5. MCP tools: get their specs so the model knows about them.
  //  getMcpToolSpecs returns Bedrock Tool[] — we wrap them as FunctionTool
  //  so Strands can invoke them. inputSchema is unwrapped from Bedrock's
  //  `{ json: <schema> }` envelope into the raw JSON Schema that Strands expects.
  const mcpSpecs = await getMcpToolSpecs(workerId, mcpConfig);
  const mcpStrandsTools = mcpSpecs
    .filter((spec) => spec.toolSpec?.name)
    .map((spec) => {
      const rawName = spec.toolSpec!.name!;
      const name = sanitizeToolName(rawName);
      const description = spec.toolSpec!.description ?? name;
      // Unwrap Bedrock's inputSchema envelope: { json: <schema> } → raw schema
      const rawSchema = (spec.toolSpec!.inputSchema as { json?: unknown })?.json;
      return new FunctionTool({
        name,
        description,
        inputSchema: rawSchema as Record<string, unknown> | undefined,
        callback: async (input: unknown, _ctx: ToolContext) => {
          const result = await tryExecuteMcpTool(workerId, rawName, input);
          if (!result.found) throw new Error(`MCP tool ${name} not found`);
          if (typeof result.content === 'string') return result.content;
          if (Array.isArray(result.content)) {
            return mcpContentToSdkBlocks(result.content, normalizeMcpImageFormat);
          }
          return JSON.stringify(result.content);
        },
      });
    });

  const allStrandsTools = [...strandsTools, ...mcpStrandsTools];

  // Convert stored history (Bedrock-wire MessageItems) → Strands MessageData.
  // ctx.history items carry `content` (JSON string of Bedrock ContentBlock[]).
  const toStrandsMessageData = (item: TurnContext['history'][number]) => {
    let content: unknown;
    try {
      content = JSON.parse(item.content);
    } catch {
      content = [{ text: item.content }];
    }
    const bedrockMsg: BedrockMessage = {
      role: item.role === 'assistant' ? 'assistant' : 'user',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: (Array.isArray(content) ? content : [{ text: String(content) }]) as any,
    };
    return bedrockToStrandsMessage(bedrockMsg, s3);
  };

  // buildTurnContext puts the CURRENT user turn as the last history item.
  // If we seed the whole history AND then invoke(ctx.userMessage), the model sees
  // this turn twice (invoke's string arg is appended as a NEW user message) and
  // image blocks on the current turn are lost (userMessage is text-only). So:
  //  - seed = history EXCEPT the trailing current-user item
  //  - invoke arg = the trailing current-user item as MessageData[] (a legal
  //  InvokeArgs member that preserves image/file blocks, no double-injection).
  // If the last item is not a user turn (defensive), fall back to seeding all and
  // invoking the plain userMessage text.
  const history = ctx.history;
  const lastItem = history.at(-1);
  const lastIsUser = !!lastItem && lastItem.role === 'user';
  const seedItems = lastIsUser ? history.slice(0, -1) : history;

  // Items array for per-call middle-out (§3.4). Hooks append persisted items.
  const appendedItems: typeof seedItems = [];
  if (lastIsUser && lastItem) appendedItems.push(lastItem);

  const seedMessages = seedItems.map(toStrandsMessageData).filter((m) => m.content.length > 0);
  let invokeArg: unknown = lastIsUser && lastItem ? [toStrandsMessageData(lastItem)] : ctx.userMessage;

  // Track total token count for updateMessageTokenCount computation.
  let totalTokenCountSoFar = seedItems.reduce((sum, item) => sum + item.tokenCount, 0);
  let lastUserMessageSK: string | undefined = lastIsUser ? lastItem?.SK : undefined;

  // §3.4: Pass getItems + threshold to model for per-call filtering
  const maxInputTokens = (resolvedTypes[0] && modelConfigs[resolvedTypes[0] as ModelType]?.maxInputTokens) ?? 200_000;
  const tokenThreshold = Math.floor(maxInputTokens * 0.95);
  const expectedDelta = seedMessages.length - seedItems.length;
  model.updateConfig({
    ...model.getConfig(),
    getItems: () => [...seedItems, ...appendedItems],
    tokenThreshold,
    expectedDelta,
  });

  const agent = new Agent({
    model,
    systemPrompt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: seedMessages as any,
    tools: allStrandsTools,
    printer: false,
    conversationManager: new NullConversationManager(),
  });

  // --- persistence hooks (batch boundary → one item each, ) ---------------
  // Error taxonomy state — shared mutable object so BeforeToolsEvent hook
  // and runInvokeLoop reference the same state (mid-loop reset works correctly).
  const errorState: InvokeLoopState = { consecutiveErrorCount: 0, lastErrorType: '' };

  // double-persist guard: retry lives INSIDE RemoteSweBedrockModel.stream()
  // (the pRetry loop is below the Agent loop boundary), so the Agent never sees
  // a partial/retried response. BeforeToolsEvent/AfterToolsEvent fire exactly
  // once per successful model call that produces tool_use. The assert below
  // catches any violation of this invariant (e.g. if retry were ever moved above
  // the Agent boundary).
  let parentSK: string | undefined;
  let lastReasoningText: string | undefined;

  agent.addHook(BeforeToolsEvent, async (event) => {
    // Reset error circuit breaker on successful model call (legacy L429-432 parity)
    errorState.consecutiveErrorCount = 0;
    errorState.lastErrorType = '';
    // Assert: parentSK must be undefined here — if it's already set, a prior
    // BeforeToolsEvent fired without a matching AfterToolsEvent, indicating a
    // double-persist scenario (violation).
    if (parentSK !== undefined) {
      console.error(
        `[bedrockStrandsAgentLoop] ASSERT FAIL: parentSK already set (${parentSK}) at BeforeToolsEvent. Possible double-persist.`
      );
    }
    const bedrockMsg = strandsToBedrockMessage(event.message.toJSON(), s3);
    const persisted = await sink.persistToolUseMessage(workerId, bedrockMsg, {
      outputTokenCount: model.lastCallUsage?.outputTokens ?? 0,
      thinkingBudget: model.detectedThinkingBudget,
    });
    parentSK = persisted.SK;
    appendedItems.push(persisted.item);

    // Update token count on the user message that was input to this model call.
    // tokenCount = totalInputTokens - sumOfPreviouslyCountedTokens (legacy L437-444).
    // Negative values are intentional (reasoning drop adjusts total, per legacy comment).
    const usage = model.lastCallUsage;
    if (usage && lastUserMessageSK) {
      const tokenCount = computeMessageTokenCount(usage, totalTokenCountSoFar);
      await updateMessageTokenCount(workerId, lastUserMessageSK, tokenCount);
      // include both user-message attribution AND assistant outputTokens
      totalTokenCountSoFar += tokenCount + (usage.outputTokens ?? 0);
    }

    // Capture reasoning from the assistant message for per-tool emit
    const msgData = event.message.toJSON();
    const reasoningBlock = msgData.content?.find((b) => 'reasoning' in b);
    lastReasoningText = (reasoningBlock as { reasoning?: { text?: string } } | undefined)?.reasoning?.text;
  });

  agent.addHook(AfterToolsEvent, async (event) => {
    // event.message is the user Message carrying the toolResult batch.
    const bedrockMsg = strandsToBedrockMessage(event.message.toJSON(), s3);
    if (parentSK) {
      const persisted = await sink.persistToolResultMessage(workerId, bedrockMsg, parentSK);
      lastUserMessageSK = persisted.SK;
      appendedItems.push(persisted.item);
      parentSK = undefined;
    }
    lastReasoningText = undefined;
  });

  // --- per-tool webapp events ( resolution) -------------------------------
  // Legacy emits individual toolUse/toolResult events for each tool. The webapp
  // uses these for: (1) real-time tool cards, (2) sendMessageToUser special-case
  // rendering as assistant messages (not tool cards).
  agent.addHook(BeforeToolCallEvent, async (event) => {
    const toolName = event.toolUse.name;
    const toolUseId = event.toolUse.toolUseId;
    const input = event.toolUse.input;
    await sink.emitToolUseEvent(workerId, {
      toolName,
      toolUseId,
      input: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
      thinkingBudget: model.detectedThinkingBudget,
      reasoningText: lastReasoningText,
      messageSK: parentSK,
    });
  });

  // Skill activation detection — records activated skill IDs for future use.
  // NOTE: In legacy Bedrock, the `name === 'read'` detection is dead code (no
  // registered tool has that name). Registry swap is intentionally NOT done here:
  // Bedrock-name → kiro-name mapping is unsolved (from review), and
  // main baseline is "never fires" = parity is achieved by detection-only.
  // allowedTools enforcement for Bedrock is deferred (gap list, separate design).
  const activatedSkillIds = new Set<string>();
  const skillIdSet = new Set(ctx.userSkills.map((s) => s.SK));
  const SKILL_PATH_RE = /^\/tmp\/skills\/([a-zA-Z0-9_-]+)\/SKILL\.md$/;

  agent.addHook(AfterToolCallEvent, async (event) => {
    const toolName = event.toolUse.name;
    const toolUseId = event.toolUse.toolUseId;
    const resultContent = event.result?.content ?? [];
    const output = resultContent
      .map((block) => {
        if ('text' in block && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    await sink.emitToolResultEvent(workerId, {
      toolName,
      toolUseId,
      output,
    });

    // Skill activation detection: record activated skill IDs
    if (output && !output.startsWith('Error')) {
      const input = event.toolUse.input;
      const inputPath =
        typeof input === 'object' && input !== null
          ? ((input as Record<string, unknown>).path ?? (input as Record<string, unknown>).filePath)
          : undefined;
      if (typeof inputPath === 'string') {
        const match = SKILL_PATH_RE.exec(inputPath);
        if (match && skillIdSet.has(match[1]!)) {
          activatedSkillIds.add(match[1]!);
        }
      }
    }
  });

  // Cancellation: map the worker cancellation token to the Strands
  // AbortSignal so a user interrupt stops the invocation (parity with the kiro
  // ACP loop). Strands returns an AgentResult with stopReason 'cancelled'.
  const abort = new AbortController();
  const unsubscribeCancel = ctx.cancellationToken.onCancel(() => abort.abort());
  if (ctx.cancellationToken.isCancelled) abort.abort();

  // Error taxonomy — circuit breaker + errorFeedback inject + permanent-error + agentError emit
  // Extracted to invoke-loop.ts for testability. Wraps agent.invoke() with
  // retry-on-error semantics matching legacy agentLoop.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;

  try {
    result = await runInvokeLoop(
      {
        invoke: (arg) => agent.invoke(arg as any, { cancelSignal: abort.signal }),
        saveConversationHistory: makeSaveHistoryDep(appendedItems, saveConversationHistory),
        sendWebappEvent,
        sendSystemMessage,
        persistErrorBubble,
        isCancelled: () => ctx.cancellationToken.isCancelled,
        workerId,
        slackUserId: ctx.slackUserId,
      },
      invokeArg,
      errorState
    );
  } finally {
    unsubscribeCancel();
  }

  if (!result || ctx.cancellationToken.isCancelled || result.stopReason === 'cancelled') {
    return {
      assistantMessage: { role: 'assistant', content: [] },
      alreadyPersisted: true,
      previewText: '',
      skipFinalize: true,
    };
  }

  // Cost/token tracking (parity with legacy agentLoop L430-461)
  // trackTokenUsage is already called per model call inside bedrockConverse,
  // so DDB token rows are accumulated. We just need to:
  // 1. updateSessionCost — reads token rows and updates the session cost
  // 2. Compute contextUsagePercentage from last call's input context
  // 3. updateMessageTokenCount on the last user item (if possible)
  await updateSessionCost(workerId);

  // Update tokenCount for the final model call (tool-less turn, or final
  // toolResult after multi-tool sequence). BeforeToolsEvent only fires on tool_use
  // responses, so the last call (end_turn) is missed without this.
  const finalUsage = model.lastCallUsage;
  if (finalUsage && lastUserMessageSK) {
    const tokenCount = computeMessageTokenCount(finalUsage, totalTokenCountSoFar);
    await updateMessageTokenCount(workerId, lastUserMessageSK, tokenCount);
    totalTokenCountSoFar += tokenCount + (finalUsage.outputTokens ?? 0);
  }

  const lastUsage = model.lastCallUsage;
  let lastContextUsagePercentage: number | undefined;

  if (lastUsage) {
    const maxInputTokens = (resolvedTypes[0] && modelConfigs[resolvedTypes[0] as ModelType]?.maxInputTokens) ?? 200_000;
    const inputContextTokens = lastUsage.inputTokens + lastUsage.cacheReadInputTokens + lastUsage.cacheWriteInputTokens;
    if (inputContextTokens > 0 && maxInputTokens > 0) {
      lastContextUsagePercentage = (inputContextTokens / maxInputTokens) * 100;
    }
  }

  // Final assistant message — convert the full Strands Message (including
  // reasoningContent blocks) to Bedrock wire format and persist it directly
  // ( fix: legacy persists the complete message, not just a text extraction).
  const lastMessage = result.lastMessage;
  const fullAssistantMessage = strandsToBedrockMessage(lastMessage.toJSON(), s3);

  // Preview text: last text block with <thinking> tags stripped (legacy parity)
  const responseText =
    fullAssistantMessage.content?.filter((b) => 'text' in b && typeof b.text === 'string').pop()?.text ??
    fullAssistantMessage.content?.find((b) => 'text' in b && typeof b.text === 'string')?.text ??
    '';
  const previewText = (responseText as string).replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();

  if (previewText.length === 0 && (!fullAssistantMessage.content || fullAssistantMessage.content.length === 0)) {
    // Legacy parity: notify user on empty final message (content filter, etc.)
    const slackUserId = ctx.slackUserId;
    const mention = slackUserId ? `<@${slackUserId}> ` : '';
    const bedrockStopReason = result.stopReason === 'contentFiltered' ? 'content_filtered' : result.stopReason;
    console.log(`final message is empty (stopReason: ${bedrockStopReason}).`);
    await sendSystemMessage(workerId, emptyFinalMessageNotification(bedrockStopReason, mention), true);
    return {
      assistantMessage: { role: 'assistant', content: [] },
      alreadyPersisted: true,
      previewText: '',
      skipFinalize: true,
    };
  }

  // Persist with output token count and thinkingBudget (legacy parity)
  const outputTokenCount = model.lastCallUsage?.outputTokens ?? 0;
  const savedItem = await saveConversationHistory(
    workerId,
    fullAssistantMessage,
    outputTokenCount,
    'assistant',
    model.detectedThinkingBudget
  );

  return {
    assistantMessage: fullAssistantMessage,
    alreadyPersisted: true,
    previewText,
    contextUsagePercentage: lastContextUsagePercentage,
    messageSK: savedItem.SK,
  };
};
