import { SSMClient, GetParameterCommand, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const stackName = process.env.STACK_NAME || 'default';

export const sanitizeUserId = (userId: string): string => {
  // Strip platform prefixes (e.g. "webapp#uuid", "slack#uid")
  const stripped = userId.includes('#') ? userId.split('#').pop()! : userId;
  if (!/^[a-zA-Z0-9\-_.]+$/.test(stripped)) {
    throw new Error(`Invalid userId for SSM parameter: ${userId}`);
  }
  return stripped;
};

const getParameterName = (userId: string) => {
  const sanitized = sanitizeUserId(userId);
  return `/${stackName}/users/${sanitized}/kiro-api-key`;
};

export const getKiroApiKey = async (userId: string): Promise<string | undefined> => {
  try {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: getParameterName(userId),
        WithDecryption: true,
      })
    );
    return result.Parameter?.Value;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'ParameterNotFound') return undefined;
    throw e;
  }
};

export const putKiroApiKey = async (userId: string, apiKey: string): Promise<void> => {
  await ssm.send(
    new PutParameterCommand({
      Name: getParameterName(userId),
      Value: apiKey,
      Type: 'SecureString',
      Overwrite: true,
    })
  );
};

export const deleteKiroApiKey = async (userId: string): Promise<void> => {
  try {
    await ssm.send(
      new DeleteParameterCommand({
        Name: getParameterName(userId),
      })
    );
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'ParameterNotFound') return;
    throw e;
  }
};
