import { getParameter } from './aws/ssm';

/**
 * Get the webapp origin URL from SSM parameter
 * First tries to use the WEBAPP_ORIGIN_NAME_PARAMETER environment variable
 * If that's not available, searches for parameters with 'OriginSourceParameter' in the name
 * @returns The webapp origin URL or undefined if not available
 */
export const getWebappOrigin = async (): Promise<string | undefined> => {
  // First try to use the environment variable if it's set
  const parameterName = process.env.WEBAPP_ORIGIN_NAME_PARAMETER;

  if (parameterName) {
    const origin = await getParameter(parameterName);
    return origin;
  }
};

/**
 * Build webapp session URL for a worker
 * @param workerId The worker ID
 * @returns The session URL or undefined if webapp origin is not available
 */
export const getWebappSessionUrl = async (workerId: string): Promise<string | undefined> => {
  const origin = await getWebappOrigin();

  if (!origin) {
    return undefined;
  }

  return `${origin}/sessions/${workerId}`;
};
