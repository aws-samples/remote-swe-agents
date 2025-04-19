import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandInput,
  ConverseResponse,
} from '@aws-sdk/client-bedrock-runtime';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ddb, TableName } from '@remote-swe-agents/common';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { writeFileSync } from 'fs';
import { WorkerId } from '../../common/constants';

const sts = new STSClient();
const awsAccounts = (process.env.BEDROCK_AWS_ACCOUNTS ?? '').split(',');
const roleName = process.env.BEDROCK_AWS_ROLE_NAME || 'bedrock-remote-swe-role';

const modelTypeSchema = z.enum(['sonnet3.5v1', 'sonnet3.5', 'sonnet3.7', 'haiku3.5', 'nova-pro']);
type ModelType = z.infer<typeof modelTypeSchema>;

const modelConfigSchema = z.object({
  maxOutputTokens: z.number().default(4096),
  cacheSupport: z.array(z.enum(['system', 'tool', 'message'])).default([]),
  reasoningSupport: z.boolean().default(false),
  toolChoiceSupport: z.array(z.enum(['any', 'auto', 'tool'])).default([]),
});

const modelConfigs: Record<ModelType, Partial<z.infer<typeof modelConfigSchema>>> = {
  'sonnet3.5v1': {
    maxOutputTokens: 4096,
    toolChoiceSupport: ['any', 'auto', 'tool'],
  },
  'sonnet3.5': {
    maxOutputTokens: 4096,
    toolChoiceSupport: ['any', 'auto', 'tool'],
  },
  'sonnet3.7': {
    maxOutputTokens: 8192,
    cacheSupport: ['system', 'message', 'tool'],
    reasoningSupport: true,
    toolChoiceSupport: ['any', 'auto', 'tool'],
  },
  'haiku3.5': {
    maxOutputTokens: 4096,
    toolChoiceSupport: ['any', 'auto', 'tool'],
  },
  'nova-pro': {
    maxOutputTokens: 5000,
    cacheSupport: ['system'],
    toolChoiceSupport: ['auto'],
  },
};

export const bedrockConverse = async (modelTypes: ModelType[], input: Omit<ConverseCommandInput, 'modelId'>) => {
  const modelOverride = modelTypeSchema
    .optional()
    // empty string to undefined
    .parse(process.env.MODEL_OVERRIDE ? process.env.MODEL_OVERRIDE : undefined);
  const modelType = modelOverride || chooseRandom(modelTypes);
  const { client, modelId, awsRegion, account } = await getModelClient(modelType);
  console.log(`Using ${JSON.stringify({ modelId, awsRegion, account, roleName })}`);
  const command = new ConverseCommand(
    preProcessInput(
      {
        ...input,
        modelId,
      },
      modelType
    )
  );
  const response = await client.send(command);

  // Track token usage for analytics
  await trackTokenUsage(WorkerId, modelId, response);

  return response;
};

const preProcessInput = (input: ConverseCommandInput, modelType: ModelType) => {
  const modelConfig = modelConfigSchema.parse(modelConfigs[modelType]);
  // we cannot use JSON.parse(JSON.stringify(input)) here because input sometimes contains Buffer object for image.
  input = structuredClone(input);

  // remove toolChoice if not supported
  if (input.toolConfig?.toolChoice) {
    if (modelConfig.toolChoiceSupport.every((choice) => !(choice in input.toolConfig!.toolChoice!))) {
      input.toolConfig.toolChoice = undefined;
    }
  }

  // enable or disable reasoning
  let enableReasoning = false;
  if (modelConfig.reasoningSupport) {
    if (input.toolConfig?.toolChoice != null) {
      // toolChoice and reasoning cannot be enabled at the same time
    } else if (
      input.messages?.at(-2)?.content?.at(0)?.reasoningContent == null &&
      input.messages?.at(-2)?.content?.at(-1)?.toolUse != null
    ) {
      // reasoning cannot be enabled when the last message is toolUse and toolUse does not have reasoning block.
    } else {
      enableReasoning = true;
    }
  }
  if (enableReasoning) {
    input.additionalModelRequestFields = {
      reasoning_config: {
        type: 'enabled',
        budget_tokens: 1024,
      },
    };
  } else {
    // when we disable reasoning, we have to remove
    // reasoningContent blocks from all the previous message contents
    input.messages = input.messages?.map((message) => {
      message.content = message.content?.filter((c) => {
        return !('reasoningContent' in c);
      });
      return message;
    });
  }

  // set maximum number of output tokens
  input.inferenceConfig ??= { maxTokens: modelConfig.maxOutputTokens };

  // remove cachePoints if not supported
  if (!modelConfig.cacheSupport.includes('system') && input.system) {
    for (let i = input.system.length - 1; i >= 0; i--) {
      if ('cachePoint' in input.system[i]) {
        input.system.splice(i, 1);
      }
    }
  }
  if (!modelConfig.cacheSupport.includes('tool') && input.toolConfig?.tools) {
    for (let i = input.toolConfig.tools.length - 1; i >= 0; i--) {
      if ('cachePoint' in input.toolConfig.tools[i]) {
        input.toolConfig.tools.splice(i, 1);
      }
    }
  }
  if (!modelConfig.cacheSupport.includes('message') && input.messages) {
    for (const message of input.messages) {
      const content = message.content;
      if (!content) continue;
      for (let i = content.length - 1; i >= 0; i--)
        if ('cachePoint' in content[i]) {
          content.splice(i, 1);
        }
    }
  }

  return input;
};

const getModelClient = async (modelType: ModelType) => {
  const { awsRegion, modelId } = chooseModelAndRegion(modelType);
  const account = chooseRandom(awsAccounts);
  if (!account) {
    return { client: new BedrockRuntimeClient({ region: awsRegion }), modelId };
  }
  const cred = await getCredentials(account);
  const client = new BedrockRuntimeClient({
    region: awsRegion,
    credentials: {
      accessKeyId: cred.AccessKeyId!,
      secretAccessKey: cred.SecretAccessKey!,
      sessionToken: cred.SessionToken!,
    },
  });
  return { client, modelId, awsRegion, account };
};

const chooseRandom = <T>(choices: T[]) => {
  return choices[Math.floor(Math.random() * choices.length)];
};

const chooseModelAndRegion = (modelType: ModelType) => {
  const availableRegions = ['us'];
  const region = chooseRandom(availableRegions);
  let awsRegion = 'us-west-2';
  if (region == 'eu') awsRegion = 'eu-west-1';
  if (region == 'apac') awsRegion = 'ap-northeast-1';
  let modelId = '';
  switch (modelType) {
    case 'sonnet3.5v1':
      modelId = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
      break;
    case 'sonnet3.5':
      modelId = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
      break;
    case 'sonnet3.7':
      modelId = 'anthropic.claude-3-7-sonnet-20250219-v1:0';
      break;
    case 'haiku3.5':
      modelId = 'anthropic.claude-3-5-haiku-20241022-v1:0';
      break;
    case 'nova-pro':
      modelId = 'amazon.nova-pro-v1:0';
      break;
    default:
      throw new Error(`Unknown model type: ${modelType}`);
  }
  modelId = `${region}.${modelId}`;
  return {
    modelId,
    awsRegion,
  };
};

const getCredentials = async (account: string) => {
  const roleArn = `arn:aws:iam::${account}:role/${roleName}`;
  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: 'remote-swe-session',
    })
  );
  if (!res.Credentials) {
    throw new Error('No credentials returned from assumeRole');
  }
  return res.Credentials;
};

const trackTokenUsage = async (workerId: string, modelId: string, response: ConverseResponse) => {
  if (!TableName) {
    return;
  }
  if (!response.usage) {
    console.warn('No usage information in response');
    return;
  }

  const { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens } = response.usage;

  // Retrieve or create item with PK: token-<workerId>, SK: modelId
  try {
    // Get existing item if available (ignoring race condition for brevity)
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
      // Update (increment token counts) if item exists
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
      // Create new item if it doesn't exist yet
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
