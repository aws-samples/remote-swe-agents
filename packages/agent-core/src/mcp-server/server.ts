import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import type { ToolDefinition } from '../private/common/lib';
import { zodToJsonSchemaBody } from '../private/common/lib';
import { kiroExportedTools } from './selection';
import { readEnvContext, resolveGlobalPreferences, type McpContextEnv } from './context';

/**
 * Names of the REQUIRED parameters of a tool, derived from its JSON Schema
 * (`required` array). Used to build a self-correction hint when a tool call
 * arrives with missing/empty arguments. Best-effort: any schema shape that is
 * not a plain object schema yields an empty list. Pure; exported for testing.
 */
export const requiredParamNames = (schema: ToolDefinition<unknown>['schema']): string[] => {
  try {
    const json = zodToJsonSchemaBody(schema) as { required?: unknown };
    return Array.isArray(json.required) ? (json.required.filter((r) => typeof r === 'string') as string[]) : [];
  } catch {
    return [];
  }
};

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
    // Exact-match lookup. With tool IDs aligned to the model's snake_case
    // prior, no tolerant name remapping is warranted: the ACP client rejects
    // unknown names before dispatch, so a transformed name should hard-fail
    // here rather than being silently resolved.
    const tool = toolByName.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `tool not found: ${req.params.name}.` }],
      };
    }

    // Parse + validate the arguments against the original Zod schema so
    // the MCP caller gets the same error messages a Bedrock caller would.
    const parsed = tool.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      // Self-correction hint: name the tool and enumerate its required
      // parameters so a call with missing/empty input can fix itself in one
      // retry.
      const required = requiredParamNames(tool.schema);
      const requiredHint = required.length ? ` Required parameters for "${tool.name}": ${required.join(', ')}.` : '';
      return {
        isError: true,
        content: [
          { type: 'text', text: `invalid arguments for "${tool.name}": ${parsed.error.message}.${requiredHint}` },
        ],
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
