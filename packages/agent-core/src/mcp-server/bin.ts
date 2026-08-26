#!/usr/bin/env node

/**
 * Entry point for the remote-swe MCP stdio server.
 *
 * CRITICAL: the MCP stdio transport owns stdout end-to-end — every byte we
 * write there must be a framed JSON-RPC message. Remote-swe tool handlers
 * (and several agent-core/lib helpers) historically call `console.log` to
 * surface progress / debug info. If any of those writes land on stdout the
 * MCP client sees a malformed JSON-RPC stream and fails the tool call.
 *
 * Redirect `console.log` / `console.info` / `console.debug` to stderr at
 * process start (before anything else imports), keeping `console.warn` /
 * `console.error` on stderr where they already were. Stdout becomes
 * reserved territory for the MCP SDK's JSON-RPC framing.
 */
const originalLog = console.log.bind(console);
const originalInfo = console.info.bind(console);
const originalDebug = console.debug.bind(console);
console.log = (...args: unknown[]): void => {
  // Route through the original stderr writer to preserve any formatters
  // node attaches, but avoid the Writable.write -> stdout path.
  process.stderr.write(`${args.map(formatArg).join(' ')}\n`);
};
console.info = console.log;
console.debug = console.log;
// Keep console.error / .warn untouched — they already write to stderr.

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

// Keep a reference for callers that want the originals (unused today).
void originalLog;
void originalInfo;
void originalDebug;

// Import after the console patch so any module-scope `console.log` in
// transitive dependencies (there are some) also go through stderr.
import('./server')
  .then(async ({ runStdioServer }) => {
    await runStdioServer();
  })
  .catch((err) => {
    console.error('[remote-swe mcp-server] fatal:', err);
    process.exit(1);
  });
