import Anthropic from '@anthropic-ai/sdk';
import {
  ConverseCommandInput,
  ConverseResponse,
  ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { ddb, TableName } from './aws';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { modelConfigs, ModelType } from '../schema';
import { getParameter } from './aws/ssm';

const ULTRA_THINKING_KEYWORD = 'ultrathink';

// Cache for API key to avoid repeated SSM calls
let cachedApiKey: string | undefined;

// Initialize Anthropic client
const getAnthropicClient = async () => {
  if (cachedApiKey) {
    return new Anthropic({ apiKey: cachedApiKey });
  }

  // First, check if API key is directly provided as environment variable
  let apiKey = process.env.ANTHROPIC_API_KEY;

  // If not, fetch from SSM Parameter Store
  if (!apiKey) {
    const parameterName = process.env.ANTHROPIC_API_KEY_PARAMETER_NAME;
    if (parameterName) {
      apiKey = await getParameter(parameterName);
    }
  }

  if (!apiKey) {
    throw new Error(
      'Anthropic API key not found. Set ANTHROPIC_API_KEY environment variable or ANTHROPIC_API_KEY_PARAMETER_NAME to fetch from SSM'
    );
  }

  cachedApiKey = apiKey;
  return new Anthropic({ apiKey });
};

// Convert Bedrock model type to Anthropic model name
const modelTypeToAnthropicModel = (modelType: ModelType): string => {
  const modelConfig = modelConfigs[modelType];
  // Extract the base model ID without CRI prefix
  const baseModelId = modelConfig.modelId.replace(/^(global|us|eu|apac|jp|au)\./, '');

  // Map Bedrock model IDs to Anthropic API model names (use hyphen 4-5, not dot 4.5)
  const modelMapping: Record<string, string> = {
    'anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
    'anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
    'anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
    'anthropic.claude-3-7-sonnet-20250219-v1:0': 'claude-3-7-sonnet-20250219',
    'anthropic.claude-3-5-sonnet-20241022-v2:0': 'claude-3-5-sonnet-20241022',
    'anthropic.claude-3-5-haiku-20241022-v1:0': 'claude-3-5-haiku-20241022',
    'anthropic.claude-4-opus-20250514-v1:0': 'claude-4-opus-20250514',
    'anthropic.claude-4-1-opus-20250514-v1:0': 'claude-4-1-opus-20250514',
    'anthropic.claude-4-sonnet-20250514-v1:0': 'claude-4-sonnet-20250514',
  };

  const anthropicModel = modelMapping[baseModelId];
  if (!anthropicModel) {
    console.warn(`Unknown model type ${modelType}, using default claude-sonnet-4-5-20250929`);
    return 'claude-sonnet-4-5-20250929';
  }

  return anthropicModel;
};

// Convert Bedrock ConverseCommandInput to Anthropic Messages API format
const convertToAnthropicFormat = (
  input: Omit<ConverseCommandInput, 'modelId'>,
  modelType: ModelType
): {
  messages: Anthropic.MessageParam[];
  system?: string | Anthropic.TextBlockParam[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  tools?: Anthropic.Tool[];
  thinking?: { type: 'enabled'; budget_tokens: number };
  metadata?: Anthropic.Metadata;
} => {
  const modelConfig = modelConfigs[modelType];

  // Convert messages (use ContentBlockParam for request)
  const messages: Anthropic.MessageParam[] = [];
  if (input.messages) {
    for (const msg of input.messages) {
      const content: Anthropic.ContentBlockParam[] = [];

      if (msg.content) {
        for (const c of msg.content) {
          if ('text' in c && c.text) {
            content.push({ type: 'text', text: c.text });
          } else if ('image' in c && c.image) {
            const imageData = c.image;
            if ('bytes' in imageData && imageData.bytes) {
              const bytes =
                imageData.bytes instanceof Uint8Array
                  ? imageData.bytes
                  : Array.isArray(imageData.bytes)
                    ? new Uint8Array(imageData.bytes)
                    : new Uint8Array(Object.values((imageData.bytes as Record<string, number>) ?? {}));
              const base64Data = Buffer.from(bytes).toString('base64');
              content.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: (imageData.format || 'image/png') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: base64Data,
                },
              });
            }
          } else if ('toolUse' in c && c.toolUse) {
            content.push({
              type: 'tool_use',
              id: c.toolUse.toolUseId || '',
              name: c.toolUse.name || '',
              input: c.toolUse.input || {},
            });
          } else if ('toolResult' in c && c.toolResult) {
            const toolResult = c.toolResult;
            const resultContent: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];

            if (toolResult.content) {
              for (const rc of toolResult.content) {
                if ('text' in rc && rc.text) {
                  resultContent.push({ type: 'text', text: rc.text });
                } else if ('image' in rc && rc.image && 'bytes' in rc.image) {
                  const imgBytes =
                    rc.image.bytes instanceof Uint8Array
                      ? rc.image.bytes
                      : Array.isArray(rc.image.bytes)
                        ? new Uint8Array(rc.image.bytes)
                        : new Uint8Array(Object.values((rc.image.bytes as Record<string, number>) ?? {}));
                  const base64Data = Buffer.from(imgBytes).toString('base64');
                  resultContent.push({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: (rc.image.format || 'image/png') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                      data: base64Data,
                    },
                  });
                }
              }
            }

            content.push({
              type: 'tool_result',
              tool_use_id: toolResult.toolUseId || '',
              content: resultContent,
              is_error: toolResult.status === 'error',
            });
          } else if ('reasoningContent' in c && c.reasoningContent) {
            const r = c.reasoningContent as unknown as { text?: string; reasoningText?: { text?: string } };
            const thinkingText =
              typeof r.text === 'string'
                ? r.text
                : typeof r.reasoningText?.text === 'string'
                  ? r.reasoningText.text
                  : '';
            const thinkingSignature = (c as { thinkingSignature?: string }).thinkingSignature;
            if (thinkingSignature !== undefined && thinkingSignature !== '') {
              content.push({
                type: 'thinking',
                signature: thinkingSignature,
                thinking: thinkingText,
              });
            }
          }
        }
      }

      messages.push({
        role: msg.role as 'user' | 'assistant',
        content,
      });
    }
  }

  // Convert system prompt
  let system: string | Anthropic.TextBlockParam[] | undefined;
  if (input.system && input.system.length > 0) {
    const systemBlocks: Anthropic.TextBlockParam[] = [];
    for (const s of input.system) {
      if ('text' in s && s.text) {
        const block: Anthropic.TextBlockParam = { type: 'text', text: s.text };
        const cachePoint = (s as { cachePoint?: { type?: string } }).cachePoint;
        if (cachePoint?.type === 'default') {
          (block as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' };
        }
        systemBlocks.push(block);
      }
    }
    system = systemBlocks.length === 1 ? systemBlocks[0].text : systemBlocks;
  }

  // Convert tools
  let tools: Anthropic.Tool[] | undefined;
  if (input.toolConfig?.tools && input.toolConfig.tools.length > 0) {
    tools = [];
    for (const tool of input.toolConfig.tools) {
      const spec = (tool as { toolSpec?: { name?: string; description?: string; inputSchema?: { json?: Record<string, unknown> } }; cachePoint?: { type?: string } }).toolSpec;
      if (spec) {
        const base = spec.inputSchema?.json;
        const input_schema: Anthropic.Tool.InputSchema =
          base && typeof base === 'object' && (base as { type?: string }).type === 'object'
            ? (base as Anthropic.Tool.InputSchema)
            : { type: 'object', properties: {}, required: [] };
        const anthropicTool: Anthropic.Tool = {
          name: spec.name || '',
          description: spec.description,
          input_schema,
        };
        const cachePoint = (tool as { cachePoint?: { type?: string } }).cachePoint;
        if (cachePoint?.type === 'default') {
          (anthropicTool as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' };
        }
        tools.push(anthropicTool);
      }
    }
  }

  // Get max_tokens from inference config
  const maxTokens = input.inferenceConfig?.maxTokens || 8192;

  // Handle thinking/reasoning
  let thinking: { type: 'enabled'; budget_tokens: number } | undefined;
  if (modelConfig.reasoningSupport) {
    const shouldEnableReasoning =
      !input.toolConfig?.toolChoice &&
      !(input.messages?.at(-2)?.content?.at(0) && 'reasoningContent' in input.messages.at(-2)!.content!.at(0)! &&
        input.messages?.at(-2)?.content?.at(-1) && 'toolUse' in input.messages.at(-2)!.content!.at(-1)!);

    if (shouldEnableReasoning) {
      const enableUltraThink = shouldUltraThink(input);
      const budget = enableUltraThink ? Math.min(Math.floor(modelConfig.maxOutputTokens / 2), 31999) : 2000;
      thinking = { type: 'enabled', budget_tokens: budget };
    }
  }

  return {
    messages,
    system,
    max_tokens: maxTokens,
    temperature: input.inferenceConfig?.temperature,
    top_p: input.inferenceConfig?.topP,
    tools,
    thinking,
  };
};

// Check if ultrathink mode should be enabled
const shouldUltraThink = (input: Omit<ConverseCommandInput, 'modelId'>): boolean => {
  const messages = input.messages || [];
  const lastUserMessage = messages
    .filter((message) => message.role === 'user' && message.content?.some((c) => 'text' in c && c.text))
    .pop();

  if (!lastUserMessage?.content) {
    return false;
  }

  const messageText = lastUserMessage.content
    .map((content) => {
      if ('text' in content && content.text) return content.text;
      if ('reasoningContent' in content && content.reasoningContent) {
        const r = content.reasoningContent as unknown as { text?: string; reasoningText?: { text?: string } };
        return r.text ?? r.reasoningText?.text ?? '';
      }
      return '';
    })
    .join(' ')
    .toLowerCase();

  return messageText.includes(ULTRA_THINKING_KEYWORD);
};

// Convert Anthropic response to Bedrock ConverseResponse format
const convertFromAnthropicResponse = (
  response: Anthropic.Message
): ConverseResponse => {
  const content: ContentBlock[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      content.push({ text: block.text });
    } else if (block.type === 'tool_use') {
      content.push({
        toolUse: {
          toolUseId: block.id,
          name: block.name,
          input: (block as Anthropic.ToolUseBlock).input,
        },
      } as ContentBlock);
    } else if (block.type === 'thinking') {
      const thinkingBlock = block as Anthropic.ThinkingBlock;
      const thinking = thinkingBlock.thinking;
      const signature = thinkingBlock.signature ?? '';
      content.push({
        reasoningContent: {
          reasoningText: { text: typeof thinking === 'string' ? thinking : '' },
        },
        thinkingSignature: signature,
      } as ContentBlock & { thinkingSignature?: string });
    }
  }

  const usage = response.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;

  return {
    output: {
      message: {
        role: 'assistant',
        content,
      },
    },
    stopReason: response.stop_reason as 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | undefined,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteInputTokens: usage.cache_creation_input_tokens ?? 0,
    },
    metrics: undefined,
  };
};

// Main function to call Anthropic API
export const anthropicConverse = async (
  workerId: string,
  modelTypes: ModelType[],
  input: Omit<ConverseCommandInput, 'modelId'>,
  maxTokensExceededCount = 0
): Promise<{ response: ConverseResponse; thinkingBudget?: number }> => {
  if (maxTokensExceededCount > 5) {
    throw new Error(`Max tokens exceeded too many times (${maxTokensExceededCount})`);
  }

  const client = await getAnthropicClient();
  const modelType = modelTypes[Math.floor(Math.random() * modelTypes.length)];
  const modelName = modelTypeToAnthropicModel(modelType);

  console.log(`Using Anthropic API with model: ${modelName}`);

  // Convert input format
  const { messages, system, max_tokens, temperature, top_p, tools, thinking } =
    convertToAnthropicFormat(input, modelType);

  // Build request parameters
  const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
    model: modelName,
    messages,
    max_tokens,
    ...(system && { system }),
    ...(temperature !== undefined && { temperature }),
    ...(top_p !== undefined && { top_p }),
    ...(tools && tools.length > 0 && { tools }),
  };

  // Add thinking if enabled
  if (thinking) {
    (requestParams as any).thinking = thinking;
  }

  // Note: Do not send experimental `betas` field to Anthropic API.
  // Some models currently reject unknown top-level fields with `Extra inputs are not permitted`.

  // Call Anthropic API
  const anthropicResponse = await client.messages.create(requestParams);

  // Convert response
  const response = convertFromAnthropicResponse(anthropicResponse);

  // Track token usage
  await trackTokenUsage(workerId, modelName, response);

  // Return thinking budget if ultrathink was used
  const thinkingBudget = thinking && thinking.budget_tokens !== 2000 ? thinking.budget_tokens : undefined;

  return { response, thinkingBudget };
};

// Track token usage in DynamoDB
const trackTokenUsage = async (workerId: string, modelId: string, response: ConverseResponse) => {
  if (!TableName) {
    return;
  }
  if (!response.usage) {
    console.warn('No usage information in response');
    return;
  }

  const { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens } = response.usage;

  try {
    const existingItem = await ddb.send(
      new GetCommand({
        TableName,
        Key: {
          PK: `token-${workerId}`,
          SK: modelId,
        },
      })
    );

    if (existingItem.Item) {
      await ddb.send(
        new UpdateCommand({
          TableName,
          Key: {
            PK: `token-${workerId}`,
            SK: modelId,
          },
          UpdateExpression:
            'ADD inputToken :inputTokens, outputToken :outputTokens, cacheReadInputTokens :cacheReadInputTokens, cacheWriteInputTokens :cacheWriteInputTokens',
          ExpressionAttributeValues: {
            ':inputTokens': inputTokens || 0,
            ':outputTokens': outputTokens || 0,
            ':cacheReadInputTokens': cacheReadInputTokens || 0,
            ':cacheWriteInputTokens': cacheWriteInputTokens || 0,
          },
        })
      );
    } else {
      await ddb.send(
        new PutCommand({
          TableName,
          Item: {
            PK: `token-${workerId}`,
            SK: modelId,
            inputToken: inputTokens || 0,
            outputToken: outputTokens || 0,
            cacheReadInputTokens: cacheReadInputTokens || 0,
            cacheWriteInputTokens: cacheWriteInputTokens || 0,
          },
        })
      );
    }
  } catch (error) {
    console.error('Error tracking token usage:', error);
  }
};
