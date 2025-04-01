import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandInput,
  ConverseResponse,
} from '@aws-sdk/client-bedrock-runtime';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { ddb, TableName } from './ddb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const sts = new STSClient();
const awsAccounts = (process.env.BEDROCK_AWS_ACCOUNTS ?? '').split(',');
const roleName = process.env.BEDROCK_AWS_ROLE_NAME || 'bedrock-remote-swe-role';

export type ModelType = 'sonnet3.5v1' | 'sonnet3.5' | 'sonnet3.7' | 'haiku3.5';

export const bedrockConverse = async (modelTypes: ModelType[], input: Omit<ConverseCommandInput, 'modelId'>) => {
  const modelType = chooseRandom(modelTypes);
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

  // Get worker ID from environment variable or from options
  const workerId = process.env.WORKER_ID || 'default-worker';

  // Track token usage for analytics
  await trackTokenUsage(workerId, modelId, response);

  return response;
};

const preProcessInput = (input: ConverseCommandInput, modelType: ModelType) => {
  // we cannot use JSON.parse(JSON.stringify(input)) here because input sometimes contains Buffer object for image.
  input = structuredClone(input);
  if (modelType == 'sonnet3.7') {
    input.additionalModelRequestFields = {
      reasoning_config: {
        type: 'enabled',
        budget_tokens: 1024,
      },
    };
  }
  if (modelType != 'sonnet3.7') {
    // reasoning is not supported on these models
    // remove reasoningContent blocks from message contents
    input.messages = input.messages?.map((message) => {
      message.content = message.content?.filter((c) => {
        return !('reasoningContent' in c);
      });
      return message;
    });
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

  const { inputTokens, outputTokens } = response.usage;

  // Retrieve or create item with PK: token-<workerId>, SK: modelId
  try {
    // Get existing item if available
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
          UpdateExpression: 'ADD inputToken :inputTokens, outputToken :outputTokens',
          ExpressionAttributeValues: {
            ':inputTokens': inputTokens || 0,
            ':outputTokens': outputTokens || 0,
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
          },
        })
      );
    }
  } catch (error) {
    console.error('Error tracking token usage:', error);
  }
};
