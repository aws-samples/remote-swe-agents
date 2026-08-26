import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import type { ToolDefinition } from '../private/common/lib';
import { zodToJsonSchemaBody } from '../private/common/lib';
import { kiroExportedTools } from './selection';
import { readEnvContext, resolveGlobalPreferences, type McpContextEnv } from './context';

/**
 * Build an MCP server that exposes the curated remote-swe tool catalogue.
 *
 * Each remote-swe `ToolDefinition` is wrapped into an MCP tool:
 *   - the Zod `schema` is converted to JSON Schema for the `tools/list` reply
 *   - `tools/call` invokes the handler with a synthesised
 *     `{ workerId, toolUseId, globalPreferences }` context
 *   - handler return values are translated to MCP `content[]` shape
 *
 * The server is transport-agnostic; {@link runStdioServer} adds the stdio
 * plumbing expected by kiro-cli's ACP `session/new.mcpServers`.
 */
export const buildMcpServer = (
  env: McpContextEnv = readEnvContext(),
  tools: ToolDefinition<unknown>[] = kiroExportedTools
): Server => {
  const server = new Server({ name: 'remote-swe', version: '1.0.0' }, { capabilities: { tools: {} } });

  const toolByName = new Map<string, ToolDefinition<unknown>>();
  for (const tool of tools) {
    toolByName.set(tool.name, tool);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await Promise.all(
      tools.map(async (tool) => {
        const spec = await tool.toolSpec();
        return {
          name: tool.name,
          description: spec.description ?? '',
          inputSchema: zodToJsonSchemaBody(tool.schema),
        };
      })
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolByName.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `tool not found: ${req.params.name}` }],
      };
    }

    // Parse + validate the arguments against the original Zod schema so
    // the MCP caller gets the same error messages a Bedrock caller would.
    const parsed = tool.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: 'text', text: `invalid arguments: ${parsed.error.message}` }],
      };
    }

    const globalPreferences = await resolveGlobalPreferences();
    const toolUseId =
      (req.params._meta && typeof req.params._meta.toolUseId === 'string'
        ? (req.params._meta.toolUseId as string)
        : undefined) ?? randomUUID();

    try {
      const result = await tool.handler(parsed.data, {
        workerId: env.workerId,
        toolUseId,
        globalPreferences,
        // MCP tool calls in Kiro sessions are not separately cancellable;
        // ACP `session/cancel` terminates the whole subprocess tree.
        cancellationToken: { isCancelled: false },
      });

      if (typeof result === 'string') {
        return { content: [{ type: 'text', text: result }] };
      }
      // ToolResultContentBlock[] — remote-swe's richer shape. Translate to MCP.
      return {
        content: result.map((block) => {
          if ('text' in block && typeof block.text === 'string') {
            return { type: 'text' as const, text: block.text };
          }
          if ('image' in block && block.image?.source?.bytes) {
            const bytes = block.image.source.bytes as Uint8Array | Buffer;
            const base64 = Buffer.from(bytes).toString('base64');
            const mime = `image/${block.image.format ?? 'png'}`;
            return { type: 'image' as const, data: base64, mimeType: mime };
          }
          return { type: 'text' as const, text: JSON.stringify(block) };
        }),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: 'text', text: `tool ${tool.name} failed: ${message}` }],
      };
    }
  });

  return server;
};

/** Start the MCP server on stdio. Used by the CLI entry point. */
export const runStdioServer = async (): Promise<void> => {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};
