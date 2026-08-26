import type { InferenceBackend, ToolEventSink, TurnContext, TurnResult } from '@remote-swe-agents/agent-core/lib';
import { kiroAcpSdkAgentLoop } from '../kiro-acp-sdk-agent-loop';
import { stopKiroMcpHttpServer } from '../kiro-mcp-http';

/**
 * Kiro CLI backend. Routes turns through the ACP-SDK-based loop
 * ({@link kiroAcpSdkAgentLoop}), which drives `kiro-cli acp` via
 * {@link KiroAcpAgent}.
 */
export class KiroBackend implements InferenceBackend {
  readonly kind = 'kiro-cli' as const;

  async runTurn(ctx: TurnContext, sink: ToolEventSink): Promise<TurnResult> {
    return kiroAcpSdkAgentLoop(ctx, sink);
  }

  async dispose(): Promise<void> {
    await stopKiroMcpHttpServer();
  }
}

export const kiroBackend = new KiroBackend();
