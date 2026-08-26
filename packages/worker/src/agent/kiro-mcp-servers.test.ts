import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { __internal, buildKiroMcpServerList } from './kiro-mcp-servers';
import type { CustomAgent } from '@remote-swe-agents/agent-core/schema';

const baseAgent: CustomAgent = {
  PK: 'agents',
  SK: 'default',
  name: 'test',
  description: '',
  defaultModel: 'opus4.7',
  systemPrompt: '',
  tools: [],
  useAllTools: true,
  mcpConfig: JSON.stringify({ mcpServers: {} }),
  runtimeType: 'ec2',
  includeDefaultKnowledge: true,
  iconKey: '',
  inferenceMode: 'bedrock',
} as unknown as CustomAgent;

describe('buildKiroMcpServerList', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    // The production default is stdio (see resolveTransport). These tests
    // exercise that path and should stay offline; explicitly delete
    // KIRO_MCP_TRANSPORT so an outer shell / CI env can't change the
    // transport under our feet.
    process.env = { ...originalEnv };
    delete process.env.KIRO_MCP_TRANSPORT;
    delete process.env.KIRO_MCP_DISABLED;
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  test('emits remote-swe stdio server when KIRO_MCP_DISABLED is unset (default transport = stdio)', async () => {
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    expect(servers).toHaveLength(1);
    const s = servers[0]!;
    expect(s.type).toBe('stdio');
    expect(s.name).toBe('remote-swe');
    if (s.type === 'stdio') {
      expect(s.command).toBe('npx');
      expect(s.args[0]).toBe('tsx');
      // The second argument must resolve to an absolute path ending in
      // mcp-server/bin.ts so kiro-cli can spawn us deterministically.
      expect(s.args[1]).toMatch(/\/packages\/agent-core\/src\/mcp-server\/bin\.ts$/);
      const workerId = s.env.find((e) => e.name === 'WORKER_ID');
      expect(workerId?.value).toBe('w1');
    }
  });

  test('KIRO_MCP_DISABLED=1 suppresses the remote-swe server', async () => {
    process.env.KIRO_MCP_DISABLED = '1';
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    expect(servers.find((s) => s.name === 'remote-swe')).toBeUndefined();
  });

  test('merges enabled custom-agent MCP servers after remote-swe', async () => {
    const agent = {
      ...baseAgent,
      mcpConfig: JSON.stringify({
        mcpServers: {
          custom: { command: '/bin/node', args: ['x.js'], env: { FOO: 'bar' } },
          disabled: { command: '/bin/node', args: ['y.js'], enabled: false },
          http: { url: 'https://example.com/mcp' },
        },
      }),
    } as CustomAgent;
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: agent });
    const names = servers.map((s) => s.name);
    expect(names).toContain('remote-swe');
    expect(names).toContain('custom');
    expect(names).toContain('http');
    expect(names).not.toContain('disabled');
    const httpServer = servers.find((s) => s.name === 'http');
    expect(httpServer?.type).toBe('http');
    if (httpServer?.type === 'http') {
      expect(httpServer.url).toBe('https://example.com/mcp');
    }
    const customServer = servers.find((s) => s.name === 'custom');
    if (customServer?.type === 'stdio') {
      const foo = customServer.env.find((e) => e.name === 'FOO');
      expect(foo?.value).toBe('bar');
    }
  });

  test('invalid mcpConfig JSON silently degrades (no throw, just remote-swe)', async () => {
    const agent = { ...baseAgent, mcpConfig: '{not valid json' } as CustomAgent;
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: agent });
    expect(servers.map((s) => s.name)).toEqual(['remote-swe']);
  });

  test('envRecordToAcpArray converts undefined to empty array', () => {
    expect(__internal.envRecordToAcpArray(undefined)).toEqual([]);
    expect(__internal.envRecordToAcpArray({ A: '1', B: '2' })).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
  });

  test('fingerprintMcpServers is deterministic and order-sensitive', () => {
    const a = [
      { type: 'stdio' as const, name: 'x', command: 'c', args: [], env: [] },
      { type: 'stdio' as const, name: 'y', command: 'c', args: [], env: [] },
    ];
    const b = [a[1]!, a[0]!];
    expect(__internal.fingerprintMcpServers(a)).toBe(__internal.fingerprintMcpServers(a));
    expect(__internal.fingerprintMcpServers(a)).not.toBe(__internal.fingerprintMcpServers(b));
  });
});

describe('buildKiroMcpServerList (http transport, opt-in via KIRO_MCP_TRANSPORT=http)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv, KIRO_MCP_TRANSPORT: 'http' };
    delete process.env.KIRO_MCP_DISABLED;
  });
  afterEach(async () => {
    // Ensure the singleton HTTP server is shut down between tests so
    // each case gets its own ephemeral port + secret.
    const { stopKiroMcpHttpServer } = await import('./kiro-mcp-http');
    await stopKiroMcpHttpServer();
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  test('KIRO_MCP_TRANSPORT=http emits an http descriptor with Bearer auth', async () => {
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    expect(servers).toHaveLength(1);
    const s = servers[0]!;
    expect(s.type).toBe('http');
    expect(s.name).toBe('remote-swe');
    if (s.type === 'http') {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const auth = s.headers.find((h) => h.name === 'Authorization');
      expect(auth?.value).toMatch(/^Bearer [a-f0-9]{48}$/);
    }
  });

  test('second invocation reuses the cached HTTP server (same url+secret)', async () => {
    const first = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    const second = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    const f = first[0]!;
    const s = second[0]!;
    if (f.type !== 'http' || s.type !== 'http') throw new Error('expected http');
    expect(s.url).toBe(f.url);
    const authF = f.headers.find((h) => h.name === 'Authorization')!;
    const authS = s.headers.find((h) => h.name === 'Authorization')!;
    expect(authS.value).toBe(authF.value);
  });
});

describe('resolveRemoteSweMcpBin (production-equivalence: build-independent)', () => {
  // This is a hot path: kiro-cli spawns the remote-swe MCP server from the
  // path returned here. A regression means "the agent cannot use tools".
  // We pin that the resolved path is agent-core's source `mcp-server/bin.ts`
  // and, crucially, that it resolves identically whether or not agent-core
  // has been compiled to `dist/` (dev/test vs production-equivalent build).
  const require = createRequire(import.meta.url);
  const agentCoreRoot = path.dirname(require.resolve('@remote-swe-agents/agent-core/package.json'));
  const distDir = path.join(agentCoreRoot, 'dist');
  const expectedBin = path.join(agentCoreRoot, 'src', 'mcp-server', 'bin.ts');
  // Track whether a real build already produced dist so we never delete it.
  let createdFakeDist = false;

  afterEach(() => {
    if (createdFakeDist) {
      fs.rmSync(distDir, { recursive: true, force: true });
      createdFakeDist = false;
    }
  });

  test('returns `npx tsx <agent-core>/src/mcp-server/bin.ts` (file exists)', () => {
    const { command, args } = __internal.resolveRemoteSweMcpBin();
    expect(command).toBe('npx');
    expect(args[0]).toBe('tsx');
    expect(args[1]).toBe(expectedBin);
    expect(args[1]).toMatch(/\/packages\/agent-core\/src\/mcp-server\/bin\.ts$/);
    expect(fs.existsSync(args[1]!)).toBe(true);
  });

  test('resolves to the SAME src bin path with dist absent (dev/test)', () => {
    // Only assert the dist-absent branch when dist genuinely does not exist,
    // so we never clobber a real build that another test/run produced.
    if (fs.existsSync(distDir)) return;
    const { args } = __internal.resolveRemoteSweMcpBin();
    expect(args[1]).toBe(expectedBin);
  });

  test('resolves to the SAME src bin path with dist present (production-equivalent)', () => {
    const distAlreadyExists = fs.existsSync(distDir);
    if (!distAlreadyExists) {
      // Simulate a production build: agent-core compiled to dist/. The
      // resolver must NOT start pointing at dist — it must still hand kiro-cli
      // the source bin.ts so the worker's tsx runtime can spawn it.
      fs.mkdirSync(path.join(distDir, 'mcp-server'), { recursive: true });
      fs.writeFileSync(path.join(distDir, 'mcp-server', 'index.js'), 'export {};\n');
      fs.writeFileSync(path.join(distDir, 'mcp-server', 'bin.js'), 'export {};\n');
      createdFakeDist = true;
    }
    const { command, args } = __internal.resolveRemoteSweMcpBin();
    expect(command).toBe('npx');
    expect(args[0]).toBe('tsx');
    expect(args[1]).toBe(expectedBin);
    expect(fs.existsSync(args[1]!)).toBe(true);
  });
});
