import { getPreferences } from '../lib/preferences';
import { globalPreferencesSchema, type GlobalPreferences } from '../schema';

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

/**
 * Lazy, cached accessor for global preferences so we don't hit DynamoDB for
 * every tool call.
 *
 * Fail-open: preferences are advisory (default agent name, language, ...) and
 * a DynamoDB failure must not turn every `tools/call` into an MCP internal
 * error. On failure we fall back to the schema defaults (the same shape
 * `getPreferences` returns when the item does not exist) and leave the cache
 * empty so a later call can retry.
 */
let cachedPreferences: Promise<GlobalPreferences> | null = null;
export const resolveGlobalPreferences = (): Promise<GlobalPreferences> => {
  if (!cachedPreferences) {
    cachedPreferences = getPreferences().catch((e) => {
      cachedPreferences = null;
      // stderr only: stdout is the MCP protocol channel for stdio transport.
      console.error('[mcp-server] Failed to load global preferences; using defaults:', e);
      return globalPreferencesSchema.parse({ PK: 'global-config', SK: 'general' });
    });
  }
  return cachedPreferences;
};
