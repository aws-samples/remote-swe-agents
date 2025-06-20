import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export const ssm = new SSMClient({});

/**
 * Get a parameter from SSM Parameter Store
 * @param parameterName The name of the parameter
 * @returns The parameter value
 */
export const getParameter = async (parameterName: string): Promise<string | undefined> => {
  try {
    const response = await ssm.send(
      new GetParameterCommand({
        Name: parameterName,
      })
    );
    return response.Parameter?.Value;
  } catch (error) {
    console.error(`Error getting parameter ${parameterName}:`, error);
    return undefined;
  }
};
