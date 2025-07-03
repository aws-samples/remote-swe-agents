import { readFileSync } from 'fs';
import { z } from 'zod';
import { MCPClient } from './mcp-client';
import { Tool } from '@aws-sdk/client-bedrock-runtime';

const configSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.union([
      z.object({
        command: z.string(),
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()).optional(),
        enabled: z.boolean().optional(),
      }),
      z.object({
        url: z.string(),
        enabled: z.boolean().optional(),
      }),
    ])
  ),
});

let clients: { name: string; client: MCPClient }[] = [];

const initMcp = async () => {
  const configJson = JSON.parse(readFileSync('./mcp.json').toString());
  const { success, data: config } = configSchema.safeParse(configJson);
  if (!success) {
    // how to handle this?
    throw new Error('Invalid config');
  }
  clients = (
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

export const getMcpToolSpecs = async (): Promise<Tool[]> => {
  if (clients.length === 0) {
    await initMcp();
  }
  return clients.flatMap(({ client }) => {
    return client.tools;
  });
};

export const tryExecuteMcpTool = async (toolName: string, input: any) => {
  const client = clients.find(({ client }) => client.tools.find((tool) => tool.toolSpec?.name == toolName));
  if (client == null) {
    return { found: false };
  }
  const res = await client.client.callTool(toolName, input);
  return { found: true, content: res };
};

export const closeMcpServers = async () => {
  await Promise.all(
    clients.map(async (client) => {
      await client.client.cleanup();
    })
  );
};
