import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import type { KiroAcpMcpServer } from '@remote-swe-agents/agent-core/lib';
import { EmptyMcpConfig, mcpConfigSchema, type CustomAgent } from '@remote-swe-agents/agent-core/schema';
import { getOrStartKiroMcpHttpServer } from './kiro-mcp-http';

/**
 * Which transport to expose the remote-swe MCP server over:
 *   - 'stdio' (default): subprocess + stdio, 1:1 pair with the kiro-cli
 *     subprocess. Each new kiro-cli respawn gets a fresh MCP child that
 *     is guaranteed not to carry over any per-session state from the
 *     previous subprocess.
 *   - 'http'          : localhost HTTP + shared-secret. Opt-in via
 *     `KIRO_MCP_TRANSPORT=http` for debugging or as a rollback. Known
 *     issue (April 2026): the server side of
 *     StreamableHTTPServerTransport keeps the first subprocess's
 *     Mcp-Session-Id after a SIGTERM-driven respawn; the new kiro-cli
 *     subprocess cannot re-initialise (4xx) and OAuth-discovery
 *     fallback triggers with no tools registered. The stdio path side-
 *     steps that because it is cleanly torn down together with the
 *     kiro-cli subprocess.
 *
 * `KIRO_MCP_DISABLED=1` still suppresses the remote-swe server entirely.
 */
const resolveTransport = (): 'http' | 'stdio' => {
  const v = (process.env.KIRO_MCP_TRANSPORT ?? 'stdio').toLowerCase();
  return v === 'http' ? 'http' : 'stdio';
};

/**
 * Resolve the absolute path to the compiled remote-swe MCP server entry.
 *
 * The agent-core package's `./mcp-server/bin` export points at the compiled
 * JS under `dist/mcp-server/bin.js`. In production we run through `tsx` so
 * we hand kiro-cli the source TypeScript path via tsx instead — that matches
 * how the worker itself is launched (see packages/worker/run.sh).
 */
const resolveRemoteSweMcpBin = (): { command: string; args: string[] } => {
  // Prefer src/mcp-server/bin.ts via tsx, because the worker runtime already
  // uses tsx to execute the agent-core source tree. This keeps a single
  // source-of-truth (no extra build step) and dodges the Node-ESM
  // "missing .js extension" issue we hit when running compiled dist.
  const require = createRequire(import.meta.url);
  // Anchor off agent-core's package.json rather than a compiled `./dist`
  // subpath: package.json always exists in the source tree, so this resolves
  // identically whether or not agent-core has been built (dev/test vs prod).
  // The previous `./mcp-server` anchor required `dist/` to exist and broke the
  // MCP-server spawn path (and these tests) on an unbuilt checkout.
  const anchor = require.resolve('@remote-swe-agents/agent-core/package.json');
  const agentCoreRoot = path.dirname(anchor);
  const srcBin = path.join(agentCoreRoot, 'src', 'mcp-server', 'bin.ts');
  return {
    command: 'npx',
    args: ['tsx', srcBin],
  };
};

const envRecordToAcpArray = (env: Record<string, string> | undefined): { name: string; value: string }[] => {
  if (!env) return [];
  return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
};

/**
 * Forward the worker's environment to the MCP subprocess. The subprocess runs
 * in the same container with the same IAM role, so there is no security
 * boundary to enforce. We forward all defined env vars rather than maintaining
 * a manual allowlist — the previous allowlist approach caused silent tool
 * registration failures when new CDK env vars (e.g. PREVIEW_MICROVM_IMAGE_ARN)
 * were added to the container but not to the list.
 */
const inheritedEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
};

/**
 * Parse the JSON-encoded `customAgent.mcpConfig` string into ACP-shaped
 * server descriptors. Invalid JSON or schema mismatches silently fall back
 * to an empty list rather than breaking the Kiro session.
 */
const parseCustomAgentMcpConfig = (customAgent: CustomAgent): KiroAcpMcpServer[] => {
  if (!customAgent.mcpConfig) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(customAgent.mcpConfig);
  } catch (e) {
    console.error('[kiro-mcp-servers] failed to parse customAgent.mcpConfig JSON:', e);
    return [];
  }
  const parsed = mcpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('[kiro-mcp-servers] customAgent.mcpConfig does not match schema:', parsed.error.message);
    return [];
  }
  const result: KiroAcpMcpServer[] = [];
  for (const [name, entry] of Object.entries(parsed.data.mcpServers)) {
    if (entry.enabled === false) continue;
    if ('url' in entry) {
      result.push({ type: 'http', name, url: entry.url, headers: [] });
    } else {
      result.push({
        type: 'stdio',
        name,
        command: entry.command,
        args: entry.args,
        env: envRecordToAcpArray(entry.env),
      });
    }
  }
  return result;
};

/**
 * Build the full list of MCP servers to expose to a Kiro session.
 *
 * Layout:
 *   1. `remote-swe` (our curated catalogue) — always present unless disabled
 *      via `KIRO_MCP_DISABLED=1` for debugging.
 *   2. Any user-defined MCP servers from the custom agent's mcpConfig,
 *      translated from the internal record shape into ACP's array shape.
 */
export const buildKiroMcpServerList = async (opts: {
  workerId: string;
  customAgent: CustomAgent;
}): Promise<KiroAcpMcpServer[]> => {
  if (process.env.KIRO_MCP_DISABLED === '1') {
    return parseCustomAgentMcpConfig(opts.customAgent);
  }

  const transport = resolveTransport();
  const remoteSwe =
    transport === 'http'
      ? await buildRemoteSweHttpDescriptor(opts.workerId)
      : buildRemoteSweStdioDescriptor(opts.workerId);

  return [remoteSwe, ...parseCustomAgentMcpConfig(opts.customAgent)];
};

/**
 * http transport (default): spawn a long-lived localhost HTTP MCP server
 * inside the worker process and hand kiro-cli its URL + bearer secret.
 * See packages/worker/src/agent/kiro-mcp-http.ts for the lifecycle.
 */
const buildRemoteSweHttpDescriptor = async (workerId: string): Promise<KiroAcpMcpServer> => {
  const running = await getOrStartKiroMcpHttpServer(workerId);
  return {
    type: 'http',
    name: 'remote-swe',
    url: running.url,
    headers: [{ name: 'Authorization', value: `Bearer ${running.secret}` }],
  };
};

/**
 * stdio transport (legacy / rollback): kiro-cli spawns the MCP server as
 * its own subprocess via `npx tsx <bin.ts>`. This path is still covered
 * by bin.ts's stdout-hygiene redirect but is no longer the default.
 */
const buildRemoteSweStdioDescriptor = (workerId: string): KiroAcpMcpServer => {
  const { command, args } = resolveRemoteSweMcpBin();
  const baseEnv = inheritedEnv();
  return {
    type: 'stdio',
    name: 'remote-swe',
    command,
    args,
    env: [{ name: 'WORKER_ID', value: workerId }, ...envRecordToAcpArray(baseEnv)],
  };
};

// Re-export for worker-side unit tests.
export const __internal = {
  envRecordToAcpArray,
  parseCustomAgentMcpConfig,
  fingerprintMcpServers: (servers: KiroAcpMcpServer[]): string => JSON.stringify(servers),
  inheritedEnv,
  resolveRemoteSweMcpBin,
};

// keep TS happy — fileURLToPath is only used if we later add __dirname-style resolution fallbacks.
void fileURLToPath;
