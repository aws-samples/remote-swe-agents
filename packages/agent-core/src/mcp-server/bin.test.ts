import { describe, expect, test } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, 'bin.ts');

const runOnce = (messages: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
  new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', BIN_PATH], {
      env: { ...process.env, WORKER_ID: 'bin-test-worker' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ stdout, stderr, exitCode: code }));
    for (const m of messages) {
      proc.stdin.write(m + '\n');
    }
    // Give the server a beat to handle the messages, then close stdin
    // so it can shut down cleanly.
    setTimeout(() => proc.stdin.end(), 2000);
  });

// This spawns a real subprocess via `npx tsx`; give it a generous budget.
// Linear time in the number of tool calls, ~3s for the initialize round-trip.
describe('mcp-server/bin stdio hygiene', () => {
  test('stdout only contains well-formed JSON-RPC lines, even when a tool side-effects via console.log', async () => {
    const { stdout, stderr, exitCode } = await runOnce([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'bin-test', version: '1' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      // `think` is side-effect-free but several helpers scattered across
      // agent-core touch console.log in production; this test only needs
      // to prove the stream stays clean.
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'think', arguments: { thought: 'hello' } },
      }),
    ]);

    expect(exitCode).toBe(0);

    // Parse every non-empty line on stdout. If any one is not valid
    // JSON-RPC (e.g. bare "ok", or a stray console.log leak), JSON.parse
    // throws and the assertion fails with a useful error.
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        throw new Error(
          `stdout contained non-JSON-RPC line: ${JSON.stringify(line)}\nstderr was:\n${stderr}\nerror: ${String(e)}`
        );
      }
      expect(parsed).toMatchObject({ jsonrpc: '2.0' });
    }
  }, 30_000);
});
