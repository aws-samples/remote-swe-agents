/**
 * Shared ACP protocol types and constants for the kiro-cli integration.
 *
 * These are the live surfaces consumed by the worker's Strands-based kiro
 * agent path (kiro-acp-agent, kiro-loop-helpers, kiro-mcp-servers) and by
 * agent-core's kiro-error-classification. They were extracted verbatim from
 * the former hand-written `kiro-acp-client.ts` when that module's runtime
 * client (KiroACPClient) was retired in favour of the Strands SDK transport.
 */

/**
 * Thrown by `prompt()` when the previous prompt did not settle within the
 * bounded settle wait, i.e. the reused subprocess is still busy / wedged.
 * Sending a new `session/prompt` into it would reproduce the kiro-cli
 * `-32603 "Prompt already in progress"` error, so we surface this distinct,
 * retryable signal instead. The worker turn loop recognises it (see
 * `isPromptTimeoutOrIdleError` in agent-core's `kiro-error-classification.ts`,
 * re-exported by the worker's `kiro-loop-helpers.ts`) and recovers by
 * recycling the subprocess (dispose → respawn → `session/load`) before
 * re-issuing the prompt on a clean process — preserving conversation memory.
 */
export const PROMPT_SETTLE_WEDGED_ERROR =
  'kiro-cli prompt did not settle before timeout; subprocess wedged (recycle required to avoid "Prompt already in progress")';

export type KiroAcpMcpServer =
  | {
      type: 'stdio';
      name: string;
      command: string;
      args: string[];
      env: { name: string; value: string }[];
    }
  | {
      type: 'http';
      name: string;
      url: string;
      headers: { name: string; value: string }[];
    }
  | {
      type: 'sse';
      name: string;
      url: string;
      headers: { name: string; value: string }[];
    };

export interface KiroPromptResult {
  stopReason: string;
  text: string;
  toolCalls: KiroToolCall[];
  /**
   * Context-window utilisation percentage [0, 100] as reported by kiro-cli's
   * `_kiro.dev/metadata` notification, captured at the latest point during
   * this prompt. `undefined` if kiro-cli never emitted a metadata
   * notification (older builds / unexpected protocol changes). This is the
   * same number kiro-cli shows in its own context indicator, so the worker's
   * auto-handover decision stays in lock-step with kiro-cli.
   */
  contextUsagePercentage?: number;
}

export interface KiroToolCall {
  toolCallId: string;
  title: string;
  kind: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  output?: string;
}

export type KiroToolCallEvent =
  | { type: 'tool_call'; toolCall: KiroToolCall }
  | { type: 'tool_call_update'; toolCallId: string; status: string; title: string; output?: string };

/**
 * Subset of the ACP `ContentBlock` oneOf shape that the client supports as
 * `session/prompt` input. The ACP spec mandates agent support for `text` and
 * `resource_link`; `image`, `audio`, and `resource` are gated on the agent's
 * `promptCapabilities`. Kiro-cli advertises `image: true`.
 */
export type KiroAcpPromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'resource_link'; name: string; uri: string; mimeType?: string; size?: number; title?: string };
