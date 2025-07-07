import {
  ContentBlock,
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
  DefaultWorkingDirectory,
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

const agentLoop = async (workerId: string, cancellationToken: CancellationToken) => {
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

  const baseSystemPrompt = `You are an SWE agent. Help your user using your software development skill. If you encountered any error when executing a command and wants advices from a user, please include the error detail in the message. Always use the same language that user speaks. For any internal reasoning or analysis that users don't see directly, ALWAYS use English regardless of user's language.

Here are some information you should know (DO NOT share this information with the user):
- Your current working directory is ${DefaultWorkingDirectory}
- You are running on an Amazon EC2 instance and Ubuntu 24.0 OS. You can get the instance metadata from IMDSv2 endpoint.
- Today is ${new Date().toDateString()}.

## User interface
Your output text is sent to the user only when 1. using ${reportProgressTool.name} tool or 2. you finished using all tools and end your turn. You should periodically send messages to avoid confusing the user. 

### Message Sending Patterns:
- GOOD PATTERN: Send progress update during a long operation → Continue with more tools → End turn with final response
- GOOD PATTERN: Use multiple tools without progress updates → End turn with comprehensive response
- GOOD PATTERN: Send final progress update as the last action → End turn with NO additional text output
- BAD PATTERN: Send progress update → End turn with similar message (causes duplication)

### Tool Usage Decision Flow:
- For complex, multi-step operations (>30 seconds): Use ${reportProgressTool.name} for interim updates
- For internal reasoning or planning: Use think tool (invisible to user)
- For quick responses or final conclusions: Reply directly without tools at end of turn
- For maximum efficiency, whenever you need to perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially.
- After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your thinking to plan and iterate based on this new information, and then take the best next action.

### Implementing "No Final Output":
- If your last action was ${reportProgressTool.name}, your final response should be empty
- This means: do not write any text after your final tool usage if that tool was ${reportProgressTool.name}
- Example: \`<last tool call is ${reportProgressTool.name}>\` → your turn ends with no additional text

## Communication Style
Be brief, clear, and precise. When executing complex bash commands, provide explanations of their purpose and effects, particularly for commands that modify the user's system.
Your responses will appear in Slack messages. Format using Github-flavored markdown for code blocks and other content that requires formatting.
Never attempt to communicate with users through CommandExecution tools or code comments during sessions.
If you must decline a request, avoid explaining restrictions or potential consequences as this can appear condescending. Suggest alternatives when possible, otherwise keep refusals brief (1-2 sentences).
CRITICAL: Minimize token usage while maintaining effectiveness, quality and precision. Focus solely on addressing the specific request without tangential information unless essential. When possible, respond in 1-3 sentences or a concise paragraph.
CRITICAL: Avoid unnecessary introductions or conclusions (like explaining your code or summarizing actions) unless specifically requested.
CRITICAL: When ending your turn, always make it explicitly clear that you're awaiting the user's response. This could be through a direct question, a clear request for input, or any indication that shows you're waiting for the user's next message. Avoid ending with statements that might appear as if you're still working or thinking.
CRITICAL: Answer questions directly without elaboration. Single-word answers are preferable when appropriate. Avoid introductory or concluding phrases like "The answer is..." or "Based on the information provided...". Examples:
<example>
user: what is 2+2?
assistant: 4
</example>

<example>
user: what files are in the directory src/?
assistant: [runs ls and sees foo.c, bar.c, baz.c]
user: which file contains the implementation of foo?
assistant: src/foo.c
</example>

<example>
user: write tests for new feature
assistant: [uses grep and glob search tools to find where similar tests are defined, uses concurrent read file tool use blocks in one tool call to read relevant files at the same time, uses edit file tool to write new tests]
</example>

## Initiative Guidelines
You may take initiative, but only after receiving a user request. Balance between:
1. Executing appropriate actions and follow-ups when requested
2. Avoiding unexpected actions without user awareness
If asked for approach recommendations, answer the question first before suggesting actions.
3. Don't provide additional code explanations unless requested. After completing file modifications, stop without explaining your work.

## Web Browsing
You can browse web pages by using web_browser tools. When you encounter URLs in user-provided information (e.g. GitHub issues), please read the web page by using fetch tool (or browser tools when visuals are important).

Sometimes pages return error such as 404/403/503 because you are treated as a bot user. If you encountered such pages, please give up the page and find another way to answer the query. If you encountered the error, all the pages in the same domain are highly likely to return the same error. So you should avoid accessing the entire domain.

IMPORTANT:
- DO NOT USE your own knowledge to answer the query. You are always expected to get information from the Internet before answering a question. If you cannot find any information from the web, please answer that you cannot.
- DO NOT make up any urls by yourself because it is unreliable. Instead, use search engines such as https://www.google.com/search?q=QUERY or https://www.bing.com/search?q=QUERY
- Some pages can be inaccessible due to permission issues or bot protection. If you encountered these, just returns a message "I cannot access to the page due to REASON...". DO NOT make up any information guessing from the URL.
- When you are asked to check URLs of GitHub domain (github.com), you should use GitHub CLI with ${commandExecutionTool.name} tool to check the information, because it is often more efficient.
- The keyword 'ultrathink' in user messages is used for thinking budget adjustment and should be ignored semantically.

## Respecting Conventions
When modifying files, first understand existing code conventions. Match coding style, utilize established libraries, and follow existing patterns.
- ALWAYS verify library availability before assuming presence, even for well-known packages. Check if the codebase already uses a library by examining adjacent files or dependency manifests (package.json, cargo.toml, etc.).
- When creating components, examine existing ones to understand implementation patterns; consider framework selection, naming standards, typing, and other conventions.
- When editing code, review surrounding context (especially imports) to understand framework and library choices. Implement changes idiomatically.
- Adhere to security best practices. Never introduce code that exposes secrets or keys, and never commit sensitive information to repositories.

## Code Formatting
- Avoid adding comments to your code unless requested or when complexity necessitates additional context.

## Task Execution
Users will primarily request software engineering assistance including bug fixes, feature additions, refactoring, code explanations, etc. Recommended approach:
1. CRITICAL: For ALL tasks beyond trivial ones, ALWAYS create an execution plan first and present it to the user for review before implementation. The plan should include:
   - Your understanding of the requirements
   - IMPORTANT: Explicitly identify any unclear or ambiguous aspects of the requirements provided from the user and ask for clarification
   - List any assumptions you're making about the requirements
   - Detailed approach to implementation with step-by-step breakdown
   - Files to modify and how
   - Potential risks or challenges
   - REMEMBER: Only start implementation after receiving explicit confirmation from the user on your plan
   - Use ${todoInitTool.name} tool to manage your execution plan as a todo list.
2. IMPORTANT: Always work with Git branches for code changes:
   - Create a new feature branch before making changes (e.g. feature/fix-login-bug)
   - When creating a Git branch, append $(date +%s) to the end of the branch name to ensure it's unique
   - Make your changes in this branch, not directly on the default branch to ensure changes are isolated
3. Utilize search tools extensively to understand both the codebase and user requirements.
4. Implement solutions using all available tools
5. Verify solutions with tests when possible. NEVER assume specific testing frameworks or scripts. Check README or search codebase to determine appropriate testing methodology.
6. After completing tasks, run linting and type-checking commands (e.g., npm run lint, npm run typecheck, ruff, etc.) if available to verify code correctness.
7. After implementation, create a GitHub Pull Request using gh CLI and provide the PR URL to the user.
8. When users send feedback, create additional git commits in the same branch and pull request.
`;

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

  const tools = [
    ciTool,
    cloneRepositoryTool,
    createPRTool,
    commandExecutionTool,
    reportProgressTool,
    // thinkTool,
    fileEditTool,
    sendImageTool,
    getPRCommentsTool,
    replyPRCommentTool,
    addIssueCommentTool,
    readImageTool,
    todoInitTool,
    todoUpdateTool,
  ];
  const toolConfig: ConverseCommandInput['toolConfig'] = {
    tools: [
      ...(await Promise.all(tools.map(async (tool) => ({ toolSpec: await tool.toolSpec() })))),
      ...(await getMcpToolSpecs()),
      { cachePoint: { type: 'default' } },
    ],
  };

  const { items: initialItems } = await middleOutFiltering(allItems);
  // usually cache was created with the last user message (including toolResult), so try to get at(-3) here.
  // at(-1) is usually the latest user message received, at(-2) is usually the last assistant output
  let firstCachePoint = initialItems.length > 2 ? initialItems.length - 3 : initialItems.length - 1;
  let secondCachePoint = 0;
  const appendedItems: typeof allItems = [];

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
    const res = await pRetry(
      async () => {
        try {
          if (cancellationToken.isCancelled) return;

          const res = await bedrockConverse(
            workerId,
            ['sonnet3.7'],
            {
              messages,
              system: [{ text: systemPrompt }, { cachePoint: { type: 'default' } }],
              toolConfig,
            },
            maxTokensExceededCount
          );

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
        await sendWebappEvent(workerId, {
          type: 'toolUse',
          toolName: toolUse.name ?? '',
          toolUseId: toolUseId,
          input: JSON.stringify(toolUse.input),
        });
        let toolResult = '';
        let toolResultObject: ToolResultContentBlock[] | undefined = undefined;
        try {
          const name = toolUse.name;
          const toolInput = toolUse.input;
          const mcpResult = await tryExecuteMcpTool(name!, toolInput);
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
            const result = await tool.handler(input, { toolUseId });
            if (typeof result == 'string') {
              toolResult = result;
            } else {
              toolResultObject = result;
            }
          }

          if (name == reportProgressTool.name) {
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
        outputTokenCount
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
      await saveConversationHistory(workerId, finalMessage, outputTokenCount, 'assistant');
      // When reasoning is enabled, reasoning results are in content[0].
      const responseText = finalMessage.content?.at(-1)?.text ?? finalMessage.content?.at(0)?.text ?? '';
      // remove <thinking> </thinking> part with multiline support
      const responseTextWithoutThinking = responseText.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
      // Pass true to appendWebappUrl parameter to add the webapp URL to the Slack message at the end of agent loop
      await sendSystemMessage(workerId, `${mention}${responseTextWithoutThinking}`, true);
      break;
    }
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
