/**
 * kiro-acp-transport
 * ===================
 * Spawns a `kiro-cli acp` subprocess and exposes its stdio as the two Web
 * streams the official ACP SDK's `ndJsonStream()` consumes. This is the
 * transport half of the KiroAcpAgent: the official
 * `@agentclientprotocol/sdk` owns the JSON-RPC wire,
 * this file only bridges a Node child process to Web streams.
 *
 * This is the live kiro ACP transport (consumed by `KiroAcpAgent` via the
 * `kiro-acp-sdk-agent-loop`). It replaced the former hand-written ACP client.
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

export interface KiroAcpProcessOptions {
  cwd?: string;
  model?: string;
  agentName?: string;
  trustAllTools?: boolean;
  apiKey?: string;
}

export interface KiroAcpProcessHandle {
  /** Web ReadableStream of the subprocess stdout (raw bytes). */
  readable: ReadableStream<Uint8Array>;
  /** Web WritableStream to the subprocess stdin (raw bytes). */
  writable: WritableStream<Uint8Array>;
  /** Underlying child process (for pid / kill / exit wiring). */
  proc: ChildProcess;
  /** Resolves with the exit code/signal once the subprocess exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (signal?: NodeJS.Signals) => void;
}

/**
 * Build the CLI arguments for kiro-cli acp based on options.
 * Exported for spawn-args assertion tests.
 */
export function buildKiroAcpArgs(options: KiroAcpProcessOptions = {}): string[] {
  const args = ['acp', '--agent-engine', 'v3'];
  return args;
}

/**
 * Spawn `kiro-cli acp` and return Web streams wired to its stdio.
 */
export function spawnKiroAcpProcess(options: KiroAcpProcessOptions = {}): KiroAcpProcessHandle {
  const apiKey = options.apiKey ?? process.env.KIRO_API_KEY;
  if (!apiKey) {
    throw new Error('KIRO_API_KEY is required (set env var or pass options.apiKey).');
  }

  const args = buildKiroAcpArgs(options);

  const home = process.env.HOME ?? '/root';
  const kiroCliPath = `${home}/.local/bin/kiro-cli`;
  const effectiveCwd = options.cwd && existsSync(options.cwd) ? options.cwd : home || '/tmp';

  const proc = spawn(kiroCliPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: effectiveCwd,
    env: {
      ...process.env,
      KIRO_API_KEY: apiKey,
      PATH: `${home}/.local/bin:${process.env.PATH}`,
    },
  });

  proc.stderr!.on('data', (d: Buffer) => {
    const text = d.toString().trim();
    if (text) console.error(`[kiro-acp stderr] ${text.slice(0, 500)}`);
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once('exit', (code, signal) => {
      console.error(`[kiro-acp] subprocess exited code=${code} signal=${signal}`);
      resolve({ code, signal });
    });
  });

  const readable = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const writable = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;

  return {
    readable,
    writable,
    proc,
    exited,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      try {
        proc.kill(signal);
      } catch {
        // already dead
      }
    },
  };
}
