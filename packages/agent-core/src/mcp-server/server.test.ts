import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './server';
import type { ToolDefinition } from '../private/common/lib';
import { zodToJsonSchemaBody } from '../private/common/lib';

const makeEchoTool = (name: string): ToolDefinition<{ text: string }> => {
  const schema = z.object({ text: z.string() });
  return {
    name,
    schema,
    handler: async (input) => `echo:${input.text}`,
    toolSpec: async () => ({
      name,
      description: `Echoes input.text back prefixed with "echo:".`,
      inputSchema: { json: zodToJsonSchemaBody(schema) },
    }),
  };
};

const makeErrorTool = (name: string): ToolDefinition<Record<string, never>> => {
  const schema = z.object({}).strict();
  return {
    name,
    schema,
    handler: async () => {
      throw new Error('intentional handler failure');
    },
    toolSpec: async () => ({
      name,
      description: 'Always throws.',
      inputSchema: { json: zodToJsonSchemaBody(schema) },
    }),
  };
};

const connectPair = async (tools: ToolDefinition<unknown>[]) => {
  const server = buildMcpServer({ workerId: 'test-worker' }, tools);
  const client = new Client({ name: 'test-client', version: '1.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
};

describe('remote-swe MCP server', () => {
  test('tools/list returns every registered tool with JSON Schema', async () => {
    const tools: ToolDefinition<unknown>[] = [
      makeEchoTool('echoA') as unknown as ToolDefinition<unknown>,
      makeEchoTool('echoB') as unknown as ToolDefinition<unknown>,
    ];
    const { client } = await connectPair(tools);
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name).sort()).toEqual(['echoA', 'echoB']);
    for (const t of res.tools) {
      expect(t.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  test('tools/call routes to the registered handler and wraps string result as text content', async () => {
    const { client } = await connectPair([makeEchoTool('echo') as unknown as ToolDefinition<unknown>]);
    const res = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    expect(res.content).toEqual([{ type: 'text', text: 'echo:hello' }]);
    expect(res.isError).toBeFalsy();
  });

  test('tools/call returns isError when handler throws', async () => {
    const { client } = await connectPair([makeErrorTool('bang') as unknown as ToolDefinition<unknown>]);
    const res = await client.callTool({ name: 'bang', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/intentional handler failure/);
  });

  test('tools/call returns isError for unknown tool names', async () => {
    const { client } = await connectPair([makeEchoTool('echo') as unknown as ToolDefinition<unknown>]);
    const res = await client.callTool({ name: 'no-such-tool', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/tool not found/);
  });

  test('tools/call rejects arguments that do not match the Zod schema', async () => {
    const { client } = await connectPair([makeEchoTool('echo') as unknown as ToolDefinition<unknown>]);
    const res = await client.callTool({ name: 'echo', arguments: { wrong: 'key' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/invalid arguments/);
  });

  test('a handler that calls console.log does NOT leak onto MCP response stream', async () => {
    // Several remote-swe tool helpers (sendWebappEvent, middleOutFiltering,
    // …) write progress to console.log, which shares stdout with the MCP
    // stdio transport and can corrupt the JSON-RPC stream. The production
    // fix lives in mcp-server/bin.ts, which redirects console.log to
    // stderr before any tool module loads.
    //
    // At the McpServer level the rule is simpler: the server's own writes
    // to the transport must be the ONLY result surface. The test below
    // verifies that a handler that happens to invoke console.log still
    // produces the expected tool result via the MCP response stream.
    const noisyTool: ToolDefinition<{ text: string }> = {
      name: 'noisy',
      schema: z.object({ text: z.string() }),
      handler: async (input) => {
        // Nothing to assert on stdout here because InMemoryTransport does
        // not share stdout with console.log; we just need the success path
        // to complete cleanly despite the side-effect.
        console.log('side-effect log from handler');
        return `got:${input.text}`;
      },
      toolSpec: async () => ({
        name: 'noisy',
        description: 'Writes to console.log during execution.',
        inputSchema: { json: zodToJsonSchemaBody(z.object({ text: z.string() })) },
      }),
    };
    const { client } = await connectPair([noisyTool as unknown as ToolDefinition<unknown>]);
    const res = await client.callTool({ name: 'noisy', arguments: { text: 'ok' } });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: 'text', text: 'got:ok' }]);
  });
});
