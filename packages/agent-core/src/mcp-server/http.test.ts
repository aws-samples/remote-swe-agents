import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpHttpServer, type RunningMcpHttpServer } from './http';
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
      description: 'Echoes input.',
      inputSchema: { json: zodToJsonSchemaBody(schema) },
    }),
  };
};

describe('mcp-server streamable-http transport', () => {
  let server: RunningMcpHttpServer;

  beforeEach(async () => {
    server = await startMcpHttpServer({ workerId: 'http-test-worker' }, [
      makeEchoTool('echo') as unknown as ToolDefinition<unknown>,
    ]);
  });

  afterEach(async () => {
    await server.close();
  });

  test('listens on localhost only and reports an ephemeral port', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(server.port).toBeGreaterThan(0);
    expect(server.secret).toMatch(/^[a-f0-9]{48}$/);
  });

  test('serves tools/list + tools/call over MCP StreamableHTTP with shared-secret auth', async () => {
    const client = new Client({ name: 'http-test-client', version: '1.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${server.secret}` },
      },
    });
    await client.connect(transport);

    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(['echo']);

    const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: 'text', text: 'echo:hi' }]);

    await client.close();
  });

  test('accepts initialize without Authorization (loopback-only, auth intentionally disabled)', async () => {
    // The kiro-cli MCP client does not carry Authorization on its GET /mcp
    // (SSE) requests, which used to 401 and break tools/list after a
    // session/load. The server now accepts any request on loopback; assert
    // that an Authorization-less POST does not hit the 401 path.
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
    });
    expect(res.status).not.toBe(401);
    await res.body?.cancel();
  });

  test('does not reject requests even with a wrong bearer (auth disabled)', async () => {
    // Previously this returned 401. Kept as a regression guard that
    // flipping auth back on is a deliberate change.
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
    });
    expect(res.status).not.toBe(401);
    await res.body?.cancel();
  });

  test('returns 404 for paths other than /mcp', async () => {
    const baseUrl = server.url.replace(/\/mcp$/, '');
    const res = await fetch(`${baseUrl}/other`, {
      method: 'GET',
      headers: { authorization: `Bearer ${server.secret}` },
    });
    expect(res.status).toBe(404);
  });

  test.each([
    '/mcpfoo', // prefix-match bypass attempt
    '/mcp/../etc/passwd', // path traversal attempt (server does not touch fs, but guards the router)
    '/mcp/trailing', // sub-path that the MCP client does not use
    '/other', // completely unrelated
    '/', // root
  ])('returns 404 for over-matching path %s even with a valid bearer', async (targetPath) => {
    const baseUrl = server.url.replace(/\/mcp$/, '');
    const res = await fetch(`${baseUrl}${targetPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.secret}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(404);
  });

  test('preserves query strings and fragments when matching /mcp', async () => {
    // The StreamableHTTP transport does not normally append query strings,
    // but a future version or a proxy might. Make sure strict matching
    // does not reject these either.
    const res = await fetch(`${server.url}?ping=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${server.secret}`,
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
    });
    // The SDK may respond 200 (streamed) or may need session id for non-initialize;
    // the important assertion here is that it is not a 404.
    expect(res.status).not.toBe(404);
  });

  test('close() is idempotent', async () => {
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
