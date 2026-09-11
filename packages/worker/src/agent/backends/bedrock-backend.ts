import type { InferenceBackend, ToolEventSink, TurnContext, TurnResult } from '@remote-swe-agents/agent-core/lib';
import { bedrockStrandsAgentLoop } from '../bedrock-strands-agent-loop';

/**
 * Bedrock backend. Routes turns through the Strands-Agent-based
 * {@link bedrockStrandsAgentLoop} (Converse API via `@strands-agents/bedrock`).
 */
export class BedrockBackend implements InferenceBackend {
  readonly kind = 'bedrock' as const;

  async runTurn(ctx: TurnContext, sink: ToolEventSink): Promise<TurnResult> {
    return bedrockStrandsAgentLoop(ctx, sink);
  }
}

export const bedrockBackend = new BedrockBackend();
