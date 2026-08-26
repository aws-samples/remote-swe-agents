/**
 * InvokableCore type-assertion test (CI-resident semver guard)
 * ============================================================================
 * Strands does NOT export `InvokableAgent` from the package root, so we depend
 * on its *shape* structurally. This test locks that contract: a plain Strands
 * `Agent` (BedrockModel + tools) and our `KiroAcpAgent` must BOTH satisfy the
 * same `InvokableCore` structural interface. If a Strands minor bump changes
 * the invoke/stream signature, this file fails to compile and CI catches it —
 * rather than production.
 *
 * TYPE-LEVEL ONLY. Nothing is invoked against Bedrock; the Agent/BedrockModel
 * instances are constructed (no network) and only referenced at the type level
 * under `if (false)` guards.
 *
 * IMPORTANT — where the enforcement actually lives: `vitest run` does NOT
 * type-check (it transpiles per-file and strips types), so the runtime
 * assertion below is essentially a placeholder. The REAL semver-drift guard is
 * the worker `tsc --noEmit` build in CI: if a Strands minor bump changes the
 * invoke/stream signature, THIS FILE fails to compile and the CI build breaks.
 * Therefore this file MUST remain within the worker `tsconfig` include set — if
 * a future tsconfig change `exclude`s test files from the type-check, this guard
 * dies SILENTLY (vitest still passes) and drift ships unnoticed. Keep the worker
 * build type-checking the test files, or move these assertions into a
 * non-test source file that tsc always compiles.
 */
import { describe, it, expect } from 'vitest';
import { Agent, BedrockModel, tool, type AgentResult } from '@strands-agents/sdk';
import { z } from 'zod';
import { KiroAcpAgent } from './kiro-acp-agent';

/** The structural compatibility point (mirrors the SDK-internal InvokableAgent.invoke). */
interface InvokableCore {
  readonly id: string;
  readonly name?: string;
  invoke(args: string, options?: { cancelSignal?: AbortSignal }): Promise<AgentResult>;
}

/** Generic streamable shape — unifies stream() by parameterising the event type. */
interface StreamableCore<E> {
  stream(args: string, options?: { cancelSignal?: AbortSignal }): AsyncGenerator<E, AgentResult, undefined>;
}

// A single polymorphic consumer. Compiling for BOTH agent kinds proves the
// "same function signature" guarantee at the invoke level.
async function runAny(agent: InvokableCore, prompt: string): Promise<string> {
  const result = await agent.invoke(prompt);
  return result.toString();
}

describe('KiroAcpAgent <-> Strands Agent type unification (compile-time)', () => {
  it('both agents satisfy InvokableCore and the generic streamable shape', () => {
    // Guarded so nothing runs against Bedrock; the value here is that this
    // block TYPE-CHECKS. If it does not compile, `vitest run` fails.
    if ((false as boolean) && typeof structuredClone === 'function') {
      const addTool = tool({
        name: 'add',
        description: 'Add two numbers',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        callback: ({ a, b }) => `${a + b}`,
      });
      const bedrockAgent = new Agent({
        model: new BedrockModel({ modelId: 'global.anthropic.claude-sonnet-4-6' }),
        tools: [addTool],
      });
      const kiroAgent = new KiroAcpAgent({ name: 'kiro' });

      // (a) invoke-level unification: both accepted by the same function.
      void runAny(bedrockAgent, 'hi');
      void runAny(kiroAgent, 'hi');

      // (b) assignability assertions.
      const asInvokable1: InvokableCore = bedrockAgent;
      const asInvokable2: InvokableCore = kiroAgent;
      void asInvokable1;
      void asInvokable2;

      // (c) streamable shape (event element type differs by design).
      const asStreamable: StreamableCore<unknown> = kiroAgent;
      void asStreamable;
    }

    // Trivial runtime assertion so the test body executes.
    expect(typeof KiroAcpAgent).toBe('function');
  });
});
