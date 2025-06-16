import { readFileSync } from 'fs';
import { z } from 'zod';
import { MCPClient } from './mcp-client';
import { Tool } from '@aws-sdk/client-bedrock-runtime';

const configSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({
      command: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()).optional(),
    })
  ),
});

let clients: { name: string; client: MCPClient }[] = [];

const initMcp = async () => {
  try {
    const configFileContent = readFileSync('./mcp.json').toString();

    // Parse JSON content
    let configJson;
    try {
      configJson = JSON.parse(configFileContent);
    } catch (e) {
      const errorMessage = `mcp.json の構文エラー: ${e.message}`;
      console.error(errorMessage);
      // sendSystemMessage is imported in agent/index.ts
      const sendSystemMessage = require('@remote-swe-agents/agent-core/lib').sendSystemMessage;
      await sendSystemMessage('system', errorMessage);
      return; // Return early without throwing, allowing agent to start without MCP
    }

    // Validate schema
    const { success, data: config, error } = configSchema.safeParse(configJson);
    if (!success) {
      const errorMessage = `mcp.json のスキーマエラー: ${error.message}`;
      console.error(errorMessage);
      const sendSystemMessage = require('@remote-swe-agents/agent-core/lib').sendSystemMessage;
      await sendSystemMessage('system', errorMessage);
      return; // Return early without throwing
    }

    clients = (
      await Promise.all(
        Object.entries(config.mcpServers).map(async ([name, config]) => {
          try {
            const client = await MCPClient.fromCommand(config.command, config.args, config.env);
            return { name, client };
          } catch (e) {
            console.log(`MCP server ${name} failed to start: ${e}. Ignoring the server...`);
          }
        })
      )
    ).filter((c) => c != null);
  } catch (e) {
    const errorMessage = `mcp.json の読み込みに失敗: ${e.message}`;
    console.error(errorMessage);
    const sendSystemMessage = require('@remote-swe-agents/agent-core/lib').sendSystemMessage;
    await sendSystemMessage('system', errorMessage);
    // Don't throw, allow agent to run without MCP
  }
};

export const getMcpToolSpecs = async (): Promise<Tool[]> => {
  if (clients.length === 0) {
    await initMcp();
  }
  // クライアントが初期化できなかった場合は空配列を返す
  if (clients.length === 0) {
    return [];
  }
  return clients.flatMap(({ client }) => {
    return client.tools;
  });
};

export const tryExecuteMcpTool = async (toolName: string, input: any) => {
  // クライアントが初期化できなかった場合は見つからなかったことにする
  if (clients.length === 0) {
    return { found: false };
  }

  const client = clients.find(({ client }) => client.tools.find((tool) => tool.toolSpec?.name == toolName));
  if (client == null) {
    return { found: false };
  }
  const res = await client.client.callTool(toolName, input);
  return { found: true, content: res };
};

export const closeMcpServers = async () => {
  // クライアントが初期化できなかった場合は何もしない
  if (clients.length === 0) {
    return;
  }

  await Promise.all(
    clients.map(async (client) => {
      await client.client.cleanup();
    })
  );
};
