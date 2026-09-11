import { startMcpHttpServer, type RunningMcpHttpServer } from '@remote-swe-agents/agent-core/mcp-server';

/**
 * Memoised reference to the running remote-swe MCP HTTP server for this
 * worker process. The server is long-lived across Kiro sessions — once
 * spawned, subsequent `buildKiroMcpServerList` calls reuse the same URL
 * + secret.
 *
 * We hold a Promise rather than the resolved value so concurrent callers
 * during the first turn await the same in-flight startup and none of
 * them race into a second `listen(0)`.
 */
let active: Promise<RunningMcpHttpServer> | null = null;

/**
 * Start (or reuse) the remote-swe MCP HTTP server for the given worker.
 *
 * The WORKER_ID only matters for DynamoDB lookups the tool handlers run;
 * we thread it through once at startup. Subsequent calls with the same
 * workerId simply reuse the cached server.
 */
export const getOrStartKiroMcpHttpServer = async (workerId: string): Promise<RunningMcpHttpServer> => {
  if (active) return active;
  active = startMcpHttpServer({ workerId });
  try {
    return await active;
  } catch (e) {
    // Let a later call retry if startup failed (e.g. ephemeral port race).
    active = null;
    throw e;
  }
};

/**
 * Graceful shutdown. Invoked from signal-handler / backend dispose.
 */
export const stopKiroMcpHttpServer = async (): Promise<void> => {
  if (!active) return;
  const ref = active;
  active = null;
  try {
    const running = await ref;
    await running.close();
  } catch (e) {
    console.error('[kiro-mcp-http] close failed:', e);
  }
};
