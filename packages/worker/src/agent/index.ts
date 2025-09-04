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
  saveConversationHistoryAtomic,
  updateMessageTokenCount,
  readMetadata,
  renderToolResult,
  sendSystemMessage,
  updateSessionCost,
  readCommonPrompt,
  getSession,
  generateSessionTitle,
  updateSessionTitle,
  getPreferences,
  getCustomAgent,
} from '@remote-swe-agents/agent-core/lib';
import pRetry, { AbortError } from 'p-retry';
import { bedrockConverse } from '@remote-swe-agents/agent-core/lib';
import { getMcpToolSpecs, tryExecuteMcpTool } from './mcp';
import {
  addIssueCommentTool,
  ciTool,
  cloneRepositoryTool,
  createPRTool,
  commandExecutionTool,
  fileEditTool,
  getPRCommentsTool,
  readImageTool,
  replyPRCommentTool,
  reportProgressTool,
  sendImageTool,
  todoInitTool,
  todoUpdateTool,
} from '@remote-swe-agents/agent-core/tools';
import { findRepositoryKnowledge } from './lib/knowledge';
import { sendWebappEvent } from '@remote-swe-agents/agent-core/lib';
import { CancellationToken } from '../common/cancellation-token';
import { updateAgentStatusWithEvent } from '../common/status';
import { refreshSession } from '../common/refresh-session';
import { DefaultAgent } from './lib/default-agent';
import { EmptyMcpConfig, mcpConfigSchema } from '@remote-swe-agents/agent-core/schema';

const agentLoop = async (workerId: string, cancellationToken: CancellationToken) => {
  const session = await getSession(workerId);
  const customAgent = (await getCustomAgent(session?.customAgentId)) ?? DefaultAgent;
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
      if (lastItem == null || lastItem.messageType === 'userMessage' || attemptCount > 4) {
        return res;
      }
      throw new Error('Last message is from assistant. Possibly DynamoDB replication delay.');
    },
    { retries: 5, minTimeout: 100, maxTimeout: 1000 }
  );
  if (!allItems) return;

  const baseSystemPrompt = customAgent.systemPrompt || DefaultAgent.systemPrompt;

  let systemPrompt = baseSystemPrompt;

  // Try to append common prompt from DynamoDB
  const tryAppendCommonPrompt = async () => {
    try {
      const commonPromptData = await readCommonPrompt();
      if (commonPromptData && commonPromptData.additionalSystemPrompt) {
        systemPrompt = `${baseSystemPrompt}\n\n## Common Prompt\n${commonPromptData.additionalSystemPrompt}`;
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

  await refreshSession(workerId);

  let modelOverride = allItems.findLast((i) => i.modelOverride)?.modelOverride;
  if (!modelOverride) {
    modelOverride = (await getPreferences()).modelOverride;
  }

  const tools = [
    ciTool,
    cloneRepositoryTool,
    createPRTool,
    commandExecutionTool,
    reportProgressTool,
    fileEditTool,
    sendImageTool,
    getPRCommentsTool,
    replyPRCommentTool,
    addIssueCommentTool,
    readImageTool,
    todoInitTool,
    todoUpdateTool,
  ].filter(
    (tool) =>
      customAgent.tools.includes(tool.name) ||
      [
        // required tools
        reportProgressTool.name,
        todoInitTool.name,
        todoUpdateTool.name,
        sendImageTool.name,
      ].includes(tool.name)
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

  const { items: initialItems, messages: initialMessages } = await middleOutFiltering(allItems);
  // usually cache was created with the last user message (including toolResult), so try to get at(-3) here.
  // at(-1) is usually the latest user message received, at(-2) is usually the last assistant output
  let firstCachePoint = initialItems.length > 2 ? initialItems.length - 3 : initialItems.length - 1;
  let secondCachePoint = 0;
  const appendedItems: typeof allItems = [];
  let conversation = `User: ${initialMessages.findLast((msg) => msg.role == 'user')?.content?.[0].text ?? ''}\n`;

  // When we get max_tokens stopReason, we double the number of max output tokens for this turn.
  // Because changing the max token count purges the prompt cache, we do not want to change it too frequently.
  let maxTokensExceededCount = 0;

  let lastReportedTime = 0;
  while (true) {
    if (cancellationToken.isCancelled) break;
    const items = [...initialItems, ...appendedItems];

    // Check if token count exceeds the threshold (95% of maxInputTokens)
    const tokenThreshold = 190_000; // TODO: use model specific parameters
    const totalBeforeFiltering = items.reduce((sum: number, item) => sum + item.tokenCount, 0);

    let result;
    if (totalBeforeFiltering > tokenThreshold) {
      // Apply middle out filtering if token count exceeds threshold
      console.log(
        `Applying middle-out during agent turn. Total tokens: ${totalBeforeFiltering}, threshold: ${tokenThreshold}`
      );
      result = await middleOutFiltering(items);
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
    // Will hold the detected budget from bedrockConverse
    let detectedBudget: number | undefined;

    const res = await pRetry(
      async () => {
        try {
          if (cancellationToken.isCancelled) return;

          const converseResult = await bedrockConverse(
            workerId,
            [modelOverride],
            {
              messages,
              system: [{ text: systemPrompt }, { cachePoint: { type: 'default' } }],
              toolConfig,
            },
            maxTokensExceededCount
          );

          const res = converseResult.response;
          // Store the detected budget in the outer scope variable
          detectedBudget = converseResult.thinkingBudget;

          if (res.stopReason == 'max_tokens') {
            maxTokensExceededCount += 1;
            throw new MaxTokenExceededError();
          }
          return res;
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
    if (!res) break;

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

      for (const request of toolUseRequests) {
        const toolUse = request.toolUse;
        const toolUseId = toolUse?.toolUseId;
        if (toolUse == null || toolUseId == null) {
          throw new Error('toolUse is null');
        }
        // Extract reasoning content if available
        const reasoningBlocks = toolUseMessage.content?.filter((block) => block.reasoningContent) ?? [];
        let reasoningText: string | undefined;
        if (reasoningBlocks.length > 0) {
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
                          format: c.mimeType.split('/')[1],
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
            const result = await tool.handler(input as any, { toolUseId, workerId });
            if (typeof result == 'string') {
              toolResult = result;
            } else {
              toolResultObject = result;
            }
          }

          if (name == reportProgressTool.name) {
            lastReportedTime = Date.now();
            const { data: input, success } = reportProgressTool.schema.safeParse(toolInput);
            if (success) {
              conversation += `Assistant: ${input.message}\n`;
            }
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
                text: renderToolResult({ toolResult, forceReport: Date.now() - lastReportedTime > 300 * 1000 }),
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
      }

      // Save both tool use and tool result messages atomically to DynamoDB
      // Pass response data to save token count information
      const savedItems = await saveConversationHistoryAtomic(
        workerId,
        toolUseMessage,
        toolResultMessage,
        outputTokenCount,
        detectedBudget
      );
      appendedItems.push(...savedItems);
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
      // Pass true to appendWebappUrl parameter to add the webapp URL to the Slack message at the end of agent loop
      await sendSystemMessage(workerId, `${mention}${responseTextWithoutThinking}`, true);
      conversation += `Assistant: ${responseTextWithoutThinking}\n`;
      break;
    }
  }

  try {
    const session = await getSession(workerId);
    // Generate title using the full conversation context
    if (conversation && !session?.title) {
      const title = await generateSessionTitle(workerId, conversation);
      if (title) {
        await updateSessionTitle(workerId, title);
        console.log(`Generated title for session ${workerId}: ${title}`);
        await sendWebappEvent(workerId, { type: 'sessionTitleUpdate', newTitle: title });
      }
    }
  } catch (error) {
    console.error(`Error generating session title for ${workerId}:`, error);
    // Continue even if title generation fails
  }
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
  if (lastItem?.messageType == 'userMessage' || lastItem?.messageType == 'toolResult') {
    return await onMessageReceived(workerId, cancellationToken);
  }
};
