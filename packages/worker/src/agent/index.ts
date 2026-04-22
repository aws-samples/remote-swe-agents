import {
  ConverseCommandInput,
  Message,
  ThrottlingException,
  ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import {
  getConversationHistory,
  middleOutFiltering,
  noOpFiltering,
  saveConversationHistory,
  saveToolUseMessage,
  saveToolResultMessage,
  repairDanglingToolUse,
  updateMessageTokenCount,
  readMetadata,
  renderToolResult,
  sendSystemMessage,
  updateSessionCost,
  readCommonPrompt,
  getSession,
  getPreferences,
  getCustomAgent,
  updateSessionLastMessage,
  getChildSessions,
} from '@remote-swe-agents/agent-core/lib';
import { resolveAgentDisplayName } from '@remote-swe-agents/agent-core/lib';
import pRetry, { AbortError } from 'p-retry';
import { converse } from '@remote-swe-agents/agent-core/lib';
import { getMcpToolSpecs, tryExecuteMcpTool } from './mcp';
import {
  allTools,
  isGitHubConfigured,
  requiredToolNames,
  gitHubTools,
  reportProgressTool,
  cloneRepositoryTool,
  sendToAgentTool,
  acknowledgeAgentTool,
} from '@remote-swe-agents/agent-core/tools';
import { findRepositoryKnowledge } from './lib/knowledge';
import { sendWebappEvent } from '@remote-swe-agents/agent-core/lib';
import { CancellationToken } from '../common/cancellation-token';
import { updateAgentStatusWithEvent } from '../common/status';
import { refreshSession } from '../common/refresh-session';
import { DefaultAgent, getEssentialSystemPrompt, getDefaultKnowledgePrompt } from './lib/default-agent';
import { EmptyMcpConfig, mcpConfigSchema, modelConfigs, ModelType } from '@remote-swe-agents/agent-core/schema';

/**
 * Tool names that should reset the lastReportedTime timer.
 * This includes tools that communicate with users OR other agents,
 * preventing the forceReport mechanism from firing unnecessarily
 * (especially in child sessions that primarily use agent-to-agent communication).
 */
export const toolNamesThatResetReportTimer = new Set([
  reportProgressTool.name,
  sendToAgentTool.name,
  acknowledgeAgentTool.name,
]);

/**
 * Check whether the given tool name should reset the lastReportedTime.
 */
export const shouldResetReportTimer = (toolName: string | undefined): boolean => {
  return toolName != null && toolNamesThatResetReportTimer.has(toolName);
};

const agentLoop = async (workerId: string, cancellationToken: CancellationToken) => {
  const session = await getSession(workerId);
  const customAgent = (await getCustomAgent(session?.customAgentId)) ?? DefaultAgent;
  const globalPreferences = await getPreferences();
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

  // For session title generation
  const { items: allItems, slackUserId } = await pRetry(
    async (attemptCount) => {
      const res = await getConversationHistory(workerId);
      const lastItem = res.items.at(-1);
      if (
        lastItem == null ||
        lastItem.messageType === 'userMessage' ||
        lastItem.messageType === 'eventTrigger' ||
        lastItem.messageType === 'agentMessage' ||
        attemptCount > 4
      ) {
        return res;
      }
      throw new Error('Last message is from assistant. Possibly DynamoDB replication delay.');
    },
    { retries: 5, minTimeout: 100, maxTimeout: 1000 }
  );
  if (!allItems) return;

  // Repair any dangling toolUse messages (toolUse without a matching toolResult)
  // that may exist from interrupted tool executions
  const repairedItems = await repairDanglingToolUse(workerId, allItems);
  if (repairedItems.length > 0) {
    // Insert repaired toolResult items at the correct positions
    for (const repairedItem of repairedItems) {
      const insertIndex = allItems.findIndex((item) => item.SK > repairedItem.SK);
      if (insertIndex === -1) {
        allItems.push(repairedItem);
      } else {
        allItems.splice(insertIndex, 0, repairedItem);
      }
    }
  }

  // Build system prompt from layers:
  // 1. Essential prompt (always included - tool usage, security, session title)
  // 2. Default knowledge prompt (included when no custom prompt, or when includeDefaultKnowledge is true)
  // 3. Custom prompt (agent-specific instructions)
  const essentialPrompt = getEssentialSystemPrompt();
  const hasCustomPrompt = Boolean(customAgent.systemPrompt);
  const includeKnowledge = !hasCustomPrompt || customAgent.includeDefaultKnowledge !== false;
  const knowledgePrompt = includeKnowledge ? getDefaultKnowledgePrompt() : '';
  const customPrompt = hasCustomPrompt ? customAgent.systemPrompt : '';

  let systemPrompt = [essentialPrompt, knowledgePrompt, customPrompt].filter(Boolean).join('\n\n');

  // Try to append common prompt from DynamoDB
  const tryAppendCommonPrompt = async () => {
    try {
      const commonPromptData = await readCommonPrompt();
      if (commonPromptData && commonPromptData.additionalSystemPrompt) {
        systemPrompt = `${systemPrompt}\n\n## Common Prompt\n${commonPromptData.additionalSystemPrompt}`;
      }
    } catch (error) {
      console.error('Error retrieving common prompt:', error);
    }
  };
  await tryAppendCommonPrompt();

  const tryAppendRepositoryKnowledge = async () => {
    try {
      const repo = await readMetadata('repo', workerId);

      // Check if metadata exists and has repository directory
      if (repo && repo.repoDirectory) {
        const repoDirectory = repo.repoDirectory as string;

        // Find repository knowledge files
        const { content: knowledgeContent, found: foundKnowledgeFile } = findRepositoryKnowledge(repoDirectory);

        if (foundKnowledgeFile) {
          // If common prompt is already added, append repository knowledge after it
          systemPrompt = `${systemPrompt}\n## Repository Knowledge\n${knowledgeContent}`;
        }
      }
    } catch (error) {
      console.error('Error retrieving repository metadata or knowledge file:', error);
    }
  };
  await tryAppendRepositoryKnowledge();

  // Inject session hierarchy information for parent-child communication
  if (session) {
    const hierarchyLines: string[] = [];
    const selfName = await resolveAgentDisplayName(session);

    if (session.parentSessionId) {
      const parentSession = await getSession(session.parentSessionId);
      const parentName = parentSession ? await resolveAgentDisplayName(parentSession) : session.parentSessionId;
      hierarchyLines.push(`You are a child agent "${selfName}" (Session ID: ${workerId}).`);
      hierarchyLines.push(`Parent: "${parentName}" (Session ID: ${session.parentSessionId})`);
      hierarchyLines.push('');
      hierarchyLines.push('### Message Routing Rules for Child Sessions');
      hierarchyLines.push('Always reply to whoever sent you the message:');
      hierarchyLines.push(
        '- **Parent agent** (via `sendMessageToAgent`) → Reply with `sendMessageToAgent` to the parent.'
      );
      hierarchyLines.push("- **User** (typed directly in this session's WebUI) → Reply with `sendMessageToUser`.");
      hierarchyLines.push('- **Event trigger** (no sender) → Report to the parent with `sendMessageToAgent`.');
      hierarchyLines.push('');
      hierarchyLines.push(
        'IMPORTANT: After calling `sendMessageToUser` or `sendMessageToAgent`, end your turn with NO text output. Text output at end-of-turn is also delivered to the user, causing duplicate messages.'
      );
      hierarchyLines.push('Use `acknowledgeAgent` for lightweight responses that do not need immediate action.');

      // Get siblings
      const siblings = await getChildSessions(session.parentSessionId);
      const otherSiblings = siblings.filter((s) => s.workerId !== workerId);
      if (otherSiblings.length > 0) {
        hierarchyLines.push('');
        hierarchyLines.push('Siblings:');
        for (const sib of otherSiblings) {
          const sibName = await resolveAgentDisplayName(sib);
          hierarchyLines.push(`- "${sibName}" (Session ID: ${sib.workerId})`);
        }
      }
    } else {
      // Check if this session has children
      const children = await getChildSessions(workerId);
      if (children.length > 0) {
        hierarchyLines.push(`You are a parent agent "${selfName}" (Session ID: ${workerId}).`);
        hierarchyLines.push('Your child agents:');
        for (const child of children) {
          const childName = await resolveAgentDisplayName(child);
          hierarchyLines.push(`- "${childName}" (Session ID: ${child.workerId})`);
        }
      }

      // Check if this session was created by another session (independent session)
      if (session.creatorSessionId) {
        const creatorSession = await getSession(session.creatorSessionId);
        const creatorName = creatorSession ? await resolveAgentDisplayName(creatorSession) : session.creatorSessionId;
        hierarchyLines.push('');
        hierarchyLines.push(`This session was created by: "${creatorName}" (Session ID: ${session.creatorSessionId})`);
        hierarchyLines.push(
          'You can use sendMessageToAgent to communicate with the creator session if you need more context or have questions.'
        );
      }
    }

    if (hierarchyLines.length > 0) {
      hierarchyLines.push('');
      hierarchyLines.push('Use sendMessageToAgent to send messages to other agents by session ID.');
      hierarchyLines.push('Use acknowledgeAgent to respond without waking up the target (like a read receipt).');
      hierarchyLines.push('');
      hierarchyLines.push('### Child vs Independent Session Decision');
      hierarchyLines.push('When creating new sessions with `createNewSession`:');
      hierarchyLines.push(
        "- **Child session (asChild=true)**: Use ONLY when the task is directly related to the CURRENT session's topic. Child sessions are deleted when the parent session ends."
      );
      hierarchyLines.push(
        '- **Independent session (asChild=false)**: Use when the task is a DIFFERENT topic from the current session. Independent sessions persist on their own.'
      );
      hierarchyLines.push('');
      hierarchyLines.push('Examples:');
      hierarchyLines.push(
        '- Current session is about "API performance tuning" → Run a load test → Child session (sub-task of the same topic)'
      );
      hierarchyLines.push(
        '- Current session is about "API performance tuning" → Fix a typo in the README → Independent session (unrelated topic)'
      );
      systemPrompt = `${systemPrompt}\n\n## Session Hierarchy\n${hierarchyLines.join('\n')}`;
    }
  }

  await refreshSession(workerId);

  let modelOverride = allItems.findLast((i) => i.modelOverride)?.modelOverride;
  if (!modelOverride) {
    modelOverride = (await getPreferences()).modelOverride;
  }

  const modelType = (modelOverride ?? customAgent.defaultModel) as ModelType;
  const maxInputTokens = modelConfigs[modelType]?.maxInputTokens ?? 200_000;
  const tokenThreshold = Math.floor(maxInputTokens * 0.95);

  const gitHubToolNames = gitHubTools.map((t) => t.name);

  const tools = allTools.filter(
    (tool) =>
      // Exclude GitHub tools if GitHub is not configured
      (isGitHubConfigured() || !gitHubToolNames.includes(tool.name)) &&
      // Include tool if useAllTools is enabled, or it's in the agent's selected tools, or is a required tool
      (customAgent.useAllTools || customAgent.tools.includes(tool.name) || requiredToolNames.includes(tool.name))
  );
  let toolConfig: ConverseCommandInput['toolConfig'] = {
    tools: [
      ...(await Promise.all(tools.map(async (tool) => ({ toolSpec: await tool.toolSpec() })))),
      ...(await getMcpToolSpecs(workerId, mcpConfig)),
      { cachePoint: { type: 'default' } },
    ],
  };
  if (toolConfig.tools!.length == 1) {
    toolConfig = undefined;
  }

  const { items: initialItems, messages: initialMessages } = await middleOutFiltering(allItems, tokenThreshold);
  // usually cache was created with the last user message (including toolResult), so try to get at(-3) here.
  // at(-1) is usually the latest user message received, at(-2) is usually the last assistant output
  let firstCachePoint = initialItems.length > 2 ? initialItems.length - 3 : initialItems.length - 1;
  let secondCachePoint = 0;
  const appendedItems: typeof allItems = [];

  // When we get max_tokens stopReason, we double the number of max output tokens for this turn.
  // Because changing the max token count purges the prompt cache, we do not want to change it too frequently.
  let maxTokensExceededCount = 0;

  // Track consecutive errors for circuit breaker
  let consecutiveErrorCount = 0;
  let lastErrorType = '';
  const MAX_CONSECUTIVE_ERRORS = 3;

  let lastReportedTime = 0;
  while (true) {
    if (cancellationToken.isCancelled) break;
    const items = [...initialItems, ...appendedItems];

    // Check if token count exceeds the threshold (95% of maxInputTokens)
    const totalBeforeFiltering = items.reduce((sum: number, item) => sum + item.tokenCount, 0);

    let result;
    if (totalBeforeFiltering > tokenThreshold) {
      // Apply middle out filtering if token count exceeds threshold
      console.log(
        `Applying middle-out during agent turn. Total tokens: ${totalBeforeFiltering}, threshold: ${tokenThreshold}`
      );
      result = await middleOutFiltering(items, tokenThreshold);
      // cache was purged anyway after middle-out
      firstCachePoint = result.messages.length - 1;
      secondCachePoint = firstCachePoint;
    } else {
      // Otherwise use noOpFiltering as before
      result = await noOpFiltering(items);
    }

    const { totalTokenCount, messages } = result;
    secondCachePoint = messages.length - 1;
    [...new Set([firstCachePoint, secondCachePoint])].forEach((cp) => {
      const message = messages[cp];
      if (message?.content) {
        message.content = [...message.content, { cachePoint: { type: 'default' } }];
      }
    });
    firstCachePoint = secondCachePoint;

    class MaxTokenExceededError {}
    // Will hold the detected budget from converse
    let detectedBudget: number | undefined;

    let res;
    try {
      res = await pRetry(
        async () => {
          try {
            if (cancellationToken.isCancelled) return;

            const converseResult = await converse(
              workerId,
              [modelOverride],
              {
                messages,
                system: [{ text: systemPrompt }, { cachePoint: { type: 'default' } }],
                toolConfig,
              },
              maxTokensExceededCount
            );

            const converseResponse = converseResult.response;
            // Store the detected budget in the outer scope variable
            detectedBudget = converseResult.thinkingBudget;

            if (converseResponse.stopReason == 'max_tokens') {
              maxTokensExceededCount += 1;
              throw new MaxTokenExceededError();
            }
            return converseResponse;
          } catch (e) {
            if (e instanceof ThrottlingException) {
              console.log(`retrying... ${e.message}`);
              throw e;
            }
            if (e instanceof MaxTokenExceededError) {
              console.log(`retrying... maxTokenExceeded ${maxTokensExceededCount} time(s)`);
              throw e;
            }
            console.log(e);
            if (e instanceof Error) {
              throw new AbortError(e);
            }
            throw e;
          }
        },
        { retries: 100, minTimeout: 1000, maxTimeout: 5000 }
      );
    } catch (e) {
      // Categorize the error for circuit breaker tracking
      const errorType = categorizeError(e);
      const errorMessage = e instanceof Error ? e.message : String(e);

      // Track consecutive errors of the same type
      if (errorType === lastErrorType) {
        consecutiveErrorCount++;
      } else {
        consecutiveErrorCount = 1;
        lastErrorType = errorType;
      }

      console.log(`Agent loop error (${errorType}, consecutive: ${consecutiveErrorCount}): ${errorMessage}`);

      // Circuit breaker: if the same error type occurs MAX_CONSECUTIVE_ERRORS times, stop and notify user
      if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        const userNotification = `The agent encountered the same error ${MAX_CONSECUTIVE_ERRORS} times consecutively and stopped to avoid an infinite loop.\n\nError type: ${errorType}\nDetails: ${errorMessage}\n\nPlease review and try again.`;
        await sendSystemMessage(
          workerId,
          slackUserId ? `<@${slackUserId}> ${userNotification}` : userNotification,
          true
        );
        break;
      }

      // Inject error feedback as a user message so the agent can understand and recover
      const recoveryHint = getRecoveryHint(errorType, errorMessage);
      const errorFeedbackMessage: Message = {
        role: 'user',
        content: [
          {
            text: `[SYSTEM ERROR FEEDBACK] An error occurred during your last response generation. Please adjust your approach and try again.\n\nError type: ${errorType}\nDetails: ${errorMessage}\n\n${recoveryHint}`,
          },
        ],
      };

      // Save the error feedback to conversation history so it persists
      const savedErrorItem = await saveConversationHistory(workerId, errorFeedbackMessage, 0, 'errorFeedback');
      appendedItems.push(savedErrorItem);

      // Notify the user that an error occurred but the agent is retrying
      await sendWebappEvent(workerId, {
        type: 'agentError',
        errorType,
        errorMessage,
        consecutiveCount: consecutiveErrorCount,
        willRetry: true,
      });

      // Continue the loop to let the agent retry with error context
      continue;
    }
    if (!res) break;

    // Reset consecutive error counter on successful response
    consecutiveErrorCount = 0;
    lastErrorType = '';

    const lastItem = items.at(-1);
    if (lastItem?.role == 'user') {
      // this can be negative because reasoningContent is dropped on a new turn
      const tokenCount =
        (res.usage?.inputTokens ?? 0) +
        (res.usage?.cacheReadInputTokens ?? 0) +
        (res.usage?.cacheWriteInputTokens ?? 0) -
        totalTokenCount;
      await updateMessageTokenCount(workerId, lastItem.SK, tokenCount);
      lastItem.tokenCount = tokenCount;
    }

    console.log(JSON.stringify(res.usage));
    const outputTokenCount = res.usage?.outputTokens ?? 0;

    // Update session cost in DynamoDB with token usage from DynamoDB
    await updateSessionCost(workerId);

    if (res.stopReason == 'tool_use') {
      if (res.output?.message == null) {
        throw new Error('output is null');
      }
      const toolUseMessage = res.output.message;
      const toolUseRequests = toolUseMessage.content?.filter((c) => 'toolUse' in c) ?? [];
      const toolResultMessage: Message = { role: 'user', content: [] };

      // Save toolUse message to DynamoDB immediately before tool execution
      // so that page reloads can show "executing..." instead of "thinking..."
      const savedToolUseItem = await saveToolUseMessage(workerId, toolUseMessage, outputTokenCount, detectedBudget);

      for (const request of toolUseRequests) {
        const toolUse = request.toolUse;
        const toolUseId = toolUse?.toolUseId;
        if (toolUse == null || toolUseId == null) {
          throw new Error('toolUse is null');
        }
        // Extract reasoning content if available
        const reasoningBlocks = toolUseMessage.content?.filter((block) => block.reasoningContent) ?? [];
        let reasoningText: string | undefined;
        if (reasoningBlocks[0]) {
          reasoningText = reasoningBlocks[0].reasoningContent?.reasoningText?.text;
        }

        await sendWebappEvent(workerId, {
          type: 'toolUse',
          toolName: toolUse.name ?? '',
          toolUseId: toolUseId,
          input: JSON.stringify(toolUse.input),
          thinkingBudget: detectedBudget,
          reasoningText,
        });
        let toolResult = '';
        let toolResultObject: ToolResultContentBlock[] | undefined = undefined;
        try {
          const name = toolUse.name;
          const toolInput = toolUse.input;
          const mcpResult = await tryExecuteMcpTool(workerId, name!, toolInput);
          if (mcpResult.found) {
            console.log(`Used MCP tool: ${name} ${JSON.stringify(toolInput)}`);
            if (typeof mcpResult.content == 'string') {
              toolResult = mcpResult.content;
            } else {
              toolResultObject = (await Promise.all(
                mcpResult.content!.map(
                  async (c): Promise<{ text: string } | { image: { format: string; source: { bytes: any } } }> => {
                    if (c.type == 'text') {
                      return {
                        text: c.text,
                      };
                    } else if (c.type == 'image') {
                      return {
                        image: {
                          format: c.mimeType.split('/')[1]!,
                          source: { bytes: Buffer.from(c.data, 'base64') },
                        },
                      };
                    } else {
                      throw new Error(`unsupported content type! ${JSON.stringify(c)}`);
                    }
                  }
                )
              )) as any;
            }
          } else {
            // mcp tool for the tool name was not found.
            const tool = tools.find((tool) => tool.name == name);
            if (tool == null) {
              throw new Error(`tool ${name} is not found`);
            }
            const schema = tool.schema;
            const { success, data: input, error } = schema.safeParse(toolInput);
            if (!success) {
              throw new Error(`invalid input: ${error}`);
            }

            console.log(`using tool: ${name} ${JSON.stringify(input)}`);
            const result = await tool.handler(input as any, {
              toolUseId,
              workerId,
              globalPreferences,
              cancellationToken,
            });
            if (typeof result == 'string') {
              toolResult = result;
            } else {
              toolResultObject = result;
            }
          }

          if (shouldResetReportTimer(name)) {
            lastReportedTime = Date.now();
          }
          if (name == cloneRepositoryTool.name) {
            // now that repository is determined, we try to update the system prompt
            await tryAppendRepositoryKnowledge();
          }
        } catch (e) {
          console.log(e);
          toolResult = `Error occurred when using tool ${toolUse.name}: ${(e as any).message}`;
        }

        toolResultMessage.content!.push({
          toolResult: {
            toolUseId,
            content: toolResultObject ?? [
              {
                text: renderToolResult({
                  toolResult,
                  forceReport: Date.now() - lastReportedTime > 300 * 1000,
                  parentSessionId: session?.parentSessionId,
                }),
              },
            ],
          },
        });
        await sendWebappEvent(workerId, {
          type: 'toolResult',
          toolName: toolUse.name ?? '',
          toolUseId: toolUseId,
          output: toolResult ? toolResult : (toolResultObject?.map((r) => r.text).join('\n') ?? ''),
        });

        // Check cancellation after each tool execution to stop early
        if (cancellationToken.isCancelled) break;
      }

      // Fill in missing tool results for tools that were not executed due to cancellation
      if (cancellationToken.isCancelled) {
        for (const request of toolUseRequests) {
          const toolUseId = request.toolUse?.toolUseId;
          if (toolUseId == null) continue;
          const alreadyHasResult = toolResultMessage.content!.some((c) => c.toolResult?.toolUseId === toolUseId);
          if (!alreadyHasResult) {
            console.log(`Filling missing toolResult for cancelled tool: ${request.toolUse?.name} (${toolUseId})`);
            toolResultMessage.content!.push({
              toolResult: {
                toolUseId,
                content: [
                  {
                    text: 'This tool execution was skipped because the agent session was interrupted by a new incoming message.',
                  },
                ],
              },
            });
          }
        }
      }

      // Save toolResult message to DynamoDB after all tools have been executed
      // If the assistant included text blocks alongside tool calls, append a warning to the last tool result
      const textBlocks = toolUseMessage.content?.filter((c) => 'text' in c && c.text) ?? [];
      if (textBlocks.length > 0) {
        const lastToolResult = toolResultMessage.content!.findLast((c) => c.toolResult);
        if (lastToolResult?.toolResult?.content) {
          lastToolResult.toolResult.content.push({
            text: '\n<system>WARNING: Your previous response included text blocks alongside tool calls. These text blocks were NOT delivered to the user. If the text was intended for the user, you must resend it using the sendMessageToUser tool.</system>',
          });
        }
      }
      const savedToolResultItem = await saveToolResultMessage(workerId, toolResultMessage, savedToolUseItem.SK);
      appendedItems.push(savedToolUseItem, savedToolResultItem);
    } else {
      const mention = slackUserId ? `<@${slackUserId}> ` : '';
      const finalMessage = res.output?.message;
      if (finalMessage?.content == null || finalMessage.content?.length == 0) {
        // It seems this happens sometimes. We can just ignore this message.
        console.log('final message is empty. ignoring...');
        await sendSystemMessage(workerId, mention, true);
        break;
      }

      // Save assistant message with token count
      await saveConversationHistory(workerId, finalMessage, outputTokenCount, 'assistant', detectedBudget);
      // When reasoning is enabled, reasoning results are in content[0].
      const responseText = finalMessage.content?.at(-1)?.text ?? finalMessage.content?.at(0)?.text ?? '';
      // remove <thinking> </thinking> part with multiline support
      const responseTextWithoutThinking = responseText.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');

      // If this is a child session and the last incoming message was from an agent,
      // redirect the end-of-turn response to the parent agent
      if (session?.parentSessionId) {
        const lastIncoming = [...initialItems, ...appendedItems].filter((i) => i.role === 'user').at(-1);
        if (lastIncoming?.messageType === 'agentMessage') {
          try {
            const { sendAgentMessage } = await import('@remote-swe-agents/agent-core/lib');
            await sendAgentMessage({
              senderWorkerId: workerId,
              targetSessionIds: [session.parentSessionId],
              message: responseTextWithoutThinking,
              acknowledge: true,
            });
          } catch (e) {
            console.error('[agent-loop] Failed to redirect end-of-turn to parent:', e);
          }
        }
      }

      const lastMessagePreview = responseTextWithoutThinking.slice(0, 500);
      if (lastMessagePreview) {
        await updateSessionLastMessage(workerId, lastMessagePreview);
        await sendWebappEvent(workerId, {
          type: 'lastMessageUpdate',
          lastMessage: lastMessagePreview,
        });
      }

      // Pass true to appendWebappUrl parameter to add the webapp URL to the Slack message at the end of agent loop
      await sendSystemMessage(workerId, `${mention}${responseTextWithoutThinking}`, true);
      break;
    }
  }
  return;
};

export const onMessageReceived = async (workerId: string, cancellationToken: CancellationToken) => {
  // Update agent status to 'working' when starting a turn
  await updateAgentStatusWithEvent(workerId, 'working');

  try {
    await agentLoop(workerId, cancellationToken);
  } finally {
    if (cancellationToken.isCancelled) {
      // execute any callback when set in the cancellation token.
      await cancellationToken.completeCancel();
    } else {
      // Update agent status to 'pending' when finishing a turn.
      // When the turn is cancelled, do not update the status to avoid race condition.
      await updateAgentStatusWithEvent(workerId, 'pending');
    }
  }
};

export const resume = async (workerId: string, cancellationToken: CancellationToken) => {
  const { items } = await getConversationHistory(workerId);
  const lastItem = items.at(-1);
  if (
    lastItem?.messageType == 'userMessage' ||
    lastItem?.messageType == 'eventTrigger' ||
    lastItem?.messageType == 'agentMessage' ||
    lastItem?.messageType == 'toolResult' ||
    lastItem?.messageType == 'toolUse' ||
    lastItem?.messageType == 'errorFeedback'
  ) {
    return await onMessageReceived(workerId, cancellationToken);
  }
};

const categorizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('max tokens exceeded too many times')) {
    return 'max_output_tokens_exceeded';
  }
  if (lowerMessage.includes('throttl')) {
    return 'throttling';
  }
  if (lowerMessage.includes('validationexception') || lowerMessage.includes('validation')) {
    return 'validation_error';
  }
  if (lowerMessage.includes('modelerrorexception') || lowerMessage.includes('model error')) {
    return 'model_error';
  }
  if (
    lowerMessage.includes('serviceunavaila') ||
    lowerMessage.includes('internalservererror') ||
    lowerMessage.includes('internal server')
  ) {
    return 'service_unavailable';
  }
  if (lowerMessage.includes('accessdenied') || lowerMessage.includes('access denied')) {
    return 'access_denied';
  }
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return 'timeout';
  }
  return 'unknown_error';
};

const getRecoveryHint = (errorType: string, errorMessage: string): string => {
  switch (errorType) {
    case 'max_output_tokens_exceeded':
      return 'Recovery hint: Your previous output was too long and exceeded the maximum output token limit even after multiple retries with increased limits. Please significantly reduce your output length. Break your response into smaller parts, use tools to write to files instead of outputting large content directly, and avoid generating very long code blocks or explanations in a single response.';
    case 'throttling':
      return 'Recovery hint: The API is being rate-limited. This is usually temporary. Please continue with your task - the system will automatically retry.';
    case 'validation_error':
      return `Recovery hint: The request was rejected due to a validation error. This may be caused by malformed input or unsupported content. Please review your last action and try a different approach. Details: ${errorMessage}`;
    case 'model_error':
      return 'Recovery hint: The model encountered an internal error processing your request. This can happen with very complex inputs. Try simplifying your approach or breaking the task into smaller steps.';
    case 'service_unavailable':
      return 'Recovery hint: The service is temporarily unavailable. Please continue with your task - the system will automatically retry.';
    case 'access_denied':
      return 'Recovery hint: Access was denied. This might be a permissions issue. Please notify the user about this error.';
    case 'timeout':
      return 'Recovery hint: The request timed out. Try reducing the complexity of your current operation or breaking it into smaller steps.';
    default:
      return `Recovery hint: An unexpected error occurred. Please try a different approach or simplify your current task. If this persists, notify the user.`;
  }
};
