import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolDefinition } from '../private/common/lib';
import { buildMcpServer } from './server';
import { kiroExportedTools } from './selection';
import { readEnvContext, type McpContextEnv } from './context';

export interface RunningMcpHttpServer {
  /** Full URL MCP clients should POST to (incl. path). */
  url: string;
  /** Shared bearer secret clients should present. See the auth note in {@link startMcpHttpServer}. */
  secret: string;
  /** TCP port the node http server listens on (localhost only). */
  port: number;
  /** Graceful shutdown, idempotent. */
  close: () => Promise<void>;
}

/**
 * Start the remote-swe MCP server behind a localhost HTTP transport.
 *
 * An MCP host connects with `{ type: 'http', url, headers: [...] }` over
 * StreamableHTTP instead of spawning a stdio subprocess. That isolates the
 * JSON-RPC stream from stdout, so stray `console.log` progress output from
 * tool handlers cannot corrupt the transport.
 *
 * Auth note: the server binds to 127.0.0.1 only and does NOT enforce the
 * bearer secret. Some MCP clients (kiro-cli among them) send Authorization
 * on the initial POST but omit it on the follow-up GET (SSE stream), so any
 * per-request auth check breaks the stream half-way through the handshake.
 * A loopback-only shared secret does not defend against anything that is
 * not already inside the container's trust boundary, so the check is
 * intentionally disabled; the secret is still generated and returned so
 * compliant clients can present it and a future version can enforce it.
 */
export const startMcpHttpServer = async (
  env: McpContextEnv = readEnvContext(),
  tools: ToolDefinition<unknown>[] = kiroExportedTools
): Promise<RunningMcpHttpServer> => {
  const mcp: McpServer = buildMcpServer(env, tools);
  const transport = new StreamableHTTPServerTransport({
    // Stateful mode: the SDK issues a session id on the first request so
    // subsequent JSON-RPC messages from the same client connection are
    // correlated. This id is not used for auth.
    sessionIdGenerator: () => randomUUID(),
  });

  await mcp.connect(transport);

  // 24 bytes = 192 bits, hex-encoded for safe transport in an HTTP header.
  const secret = randomBytes(24).toString('hex');
  const path = '/mcp';

  const httpServer = http.createServer((req, res) => {
    // Strict endpoint guard. `startsWith(path)` would have let
    // `/mcpfoo` and `/mcp/../etc/passwd` through; the bearer token is
    // not enforced (see auth note above) so the router must be tight.
    // The StreamableHTTP client only ever POSTs / GETs the single
    // `/mcp` endpoint, so exact-match is sufficient. Query strings
    // (e.g. `?id=...`) are honoured by trimming at the first `?`.
    const reqUrl = req.url ?? '';
    const basePath = reqUrl.split('?')[0]!.split('#')[0];
    if (basePath !== path) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    void transport.handleRequest(req, res).catch((err) => {
      console.error('[remote-swe mcp-server] http handleRequest failed:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const port = addr.port;
  const url = `http://127.0.0.1:${port}${path}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await transport.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { url, secret, port, close };
};
