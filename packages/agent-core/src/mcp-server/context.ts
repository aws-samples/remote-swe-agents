import { getPreferences } from '../lib/preferences';
import type { GlobalPreferences } from '../schema';

/**
 * Minimal env-driven context shared by every MCP tool handler invocation.
 *
 * The subprocess inherits the worker's IAM role; DynamoDB / AppSync / SSM
 * calls are made directly via the AWS SDK, so no IPC with the worker
 * process is required. The only values that must be passed across the
 * subprocess boundary are these identifying / routing scalars, delivered
 * via the MCP server's `env` block at spawn.
 */
export interface McpContextEnv {
  /** Worker id = session id throughout remote-swe. Required. */
  workerId: string;
}

export const readEnvContext = (): McpContextEnv => {
  const workerId = process.env.WORKER_ID;
  if (!workerId) {
    throw new Error('remote-swe MCP server: missing required env WORKER_ID');
  }
  return { workerId };
};

/** Lazy, cached accessor for global preferences so we don't hit DynamoDB for every tool call. */
let cachedPreferences: Promise<GlobalPreferences> | null = null;
export const resolveGlobalPreferences = (): Promise<GlobalPreferences> => {
  if (!cachedPreferences) {
    cachedPreferences = getPreferences();
  }
  return cachedPreferences;
};
