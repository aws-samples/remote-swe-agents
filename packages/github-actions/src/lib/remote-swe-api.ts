import * as core from '@actions/core';

export interface RemoteSweApiConfig {
  apiBaseUrl: string;
  apiKey: string;
}

export async function startRemoteSweSession(message: string, context: any, config: RemoteSweApiConfig) {
  const baseUrl = config.apiBaseUrl.endsWith('/') ? config.apiBaseUrl.slice(0, -1) : config.apiBaseUrl;
  const apiUrl = `${baseUrl}/api/sessions`;

  if (context && Object.keys(context).length > 0) {
    message += `\n\n Here is the additional context:\n${JSON.stringify(context, null, 1)}`;
  }
  const payload = {
    message,
  };

  try {
    core.info(`Making API call to: ${apiUrl}`);
    core.info(`Payload: ${JSON.stringify(payload, null, 2)}`);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}: ${response.status}`);
    }

    const responseData = await response.json();
    core.info(`Remote SWE session started successfully: ${JSON.stringify(responseData)}`);
    const sessionId = responseData.sessionId as string;
    return { sessionId, sessionUrl: `${baseUrl}/sessions/${sessionId}` };
  } catch (error) {
    core.error(`Failed to start remote SWE session: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function sendMessageToSession(
  sessionId: string,
  message: string,
  context: any,
  config: RemoteSweApiConfig
) {
  const baseUrl = config.apiBaseUrl.endsWith('/') ? config.apiBaseUrl.slice(0, -1) : config.apiBaseUrl;
  const apiUrl = `${baseUrl}/api/sessions/${sessionId}`;

  if (context && Object.keys(context).length > 0) {
    message += `\n\nHere is the additional context:\n${JSON.stringify(context, null, 1)}`;
  }

  const payload = {
    message,
  };

  try {
    core.info(`Sending message to existing session: ${apiUrl}`);
    core.info(`Payload: ${JSON.stringify(payload, null, 2)}`);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}: ${response.statusText}`);
    }

    const responseData = await response.json();
    core.info(`Message sent successfully: ${JSON.stringify(responseData)}`);
    return responseData;
  } catch (error) {
    core.error(`Failed to send message to session: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
