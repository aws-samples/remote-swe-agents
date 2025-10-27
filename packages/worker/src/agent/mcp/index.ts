import { MCPClient } from './mcp-client';
import { Tool } from '@aws-sdk/client-bedrock-runtime';
import { McpConfig } from '@remote-swe-agents/agent-core/schema';

let clientsMap: { [key: string]: { name: string; client: MCPClient }[] } = {};

const initMcp = async (workerId: string, config: McpConfig) => {
  clientsMap[workerId] = (
    await Promise.all(
      Object.entries(config.mcpServers)
        .filter(([, config]) => config.enabled !== false)
        .map(async ([name, config]) => {
          try {
            let client: MCPClient;
            if ('command' in config) {
              client = await MCPClient.fromCommand(config.command, config.args, config.env);
            } else {
              client = await MCPClient.fromUrl(config.url);
            }
            return { name, client };
          } catch (e) {
            console.log(`MCP server ${name} failed to start: ${e}. Ignoring the server...`);
          }
        })
    )
  ).filter((c) => c != null);
};

export const getMcpToolSpecs = async (workerId: string, config: McpConfig): Promise<Tool[]> => {
  if (Object.keys(config.mcpServers).length == 0) return [];
  if (!clientsMap[workerId]) {
    await initMcp(workerId, config);
  }
  return (
    clientsMap[workerId]?.flatMap(({ client }) => {
      return client.tools;
    }) ?? []
  );
};

export const tryExecuteMcpTool = async (workerId: string, toolName: string, input: any) => {
  const client = clientsMap[workerId]?.find(({ client }) =>
    client.tools.find((tool) => tool.toolSpec?.name == toolName)
  );
  if (client == null) {
    return { found: false };
  }
  const res = await client.client.callTool(toolName, input);
  return { found: true, content: res };
};

export const closeMcpServers = async () => {
  await Promise.all(
    Object.values(clientsMap).flatMap(async (clients) =>
      clients.map(async (client) => {
        await client.client.cleanup();
      })
    )
  );
};
