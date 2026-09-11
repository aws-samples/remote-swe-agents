import { Message } from '@aws-sdk/client-bedrock-runtime';
import { CustomAgent, MessageItem, SessionItem, InferenceMode, Skill } from '../../schema';

/**
 * Opaque cancellation token passed through the backend pipeline. The concrete
 * type lives in the worker package; the backend only reads `isCancelled`.
 */
export interface CancellationTokenLike {
  readonly isCancelled: boolean;
  onCancel(listener: () => void): () => void;
}

/**
 * Per-turn invocation parameters for an inference backend. Callers (the
 * worker's `onMessageReceived`) build this from DynamoDB + environment and
 * hand it to `InferenceBackend.runTurn`.
 *
 * The history / system prompt / cwd can be pre-computed by a shared helper
 * so multiple backends don't re-fetch the same data; or a backend may choose
 * to build them itself (Kiro currently does).
 */
export interface TurnContext {
  workerId: string;
  session: SessionItem | undefined;
  customAgent: CustomAgent;
  /** Full conversation history (already repaired for dangling toolUse). */
  history: MessageItem[];
  /** Composed system prompt (essential + knowledge + custom + common + repo + hierarchy). */
  systemPrompt: string;
  /** Working directory for tool execution. */
  cwd: string;
  /** Raw user text extracted from the last user message, or empty. */
  userMessage: string;
  /** Slack display id — caller uses it for Slack mention prefix. */
  slackUserId?: string;
  /** Identity of the account that sent the last message; used for SSM lookups. */
  senderUserId?: string;
  /** Signals mid-turn cancellation from ConverseSessionTracker. */
  cancellationToken: CancellationTokenLike;
  /** User's registered skills for activation detection. */
  userSkills: Skill[];
  /**
   * Dynamic per-turn ENVIRONMENT block shown to the model (design B). Currently
   * carries the session's current context-window usage so the agent can
   * self-regulate. Regenerated every turn and injected into the system layer by
   * each backend; it is NEVER persisted into conversation history, so it does
   * not accumulate context. `undefined` when there is nothing to show (e.g. the
   * usage percentage is not yet known).
   */
  environmentBlock?: string;
  /**
   * Validated kiro-cli agent name resolved during .kiro workspace deployment.
   * Only set when deployment succeeded AND the agent JSON was verified to exist.
   * When undefined, kiro-agent-loop must NOT pass --agent (deployment either
   * failed, was skipped, or no skill declares a kiro-agent).
   */
  kiroAgentName?: string;
}

/** Payload for one tool_use emission (one per tool). */
export interface ToolUseEmit {
  toolUseId: string;
  toolName: string;
  input: unknown;
  reasoningText?: string;
  thinkingBudget?: number;
  messageSK?: string;
}

/** Payload for one tool_result emission (one per tool). */
export interface ToolResultEmit {
  toolUseId: string;
  toolName: string;
  output: string;
  imageKeys?: string[];
}

/** Handle for a previously-persisted toolUse item. Carries the DynamoDB SK so
 *  the paired toolResult can chain correctly (required by repairDanglingToolUse).
 *  Backends that use the item downstream (e.g. append to `appendedItems`) get
 *  the full MessageItem back.
 */
export interface PersistedToolUse {
  SK: string;
  item: MessageItem;
}

/** Handle for a previously-persisted toolResult item. */
export interface PersistedToolResult {
  SK: string;
  item: MessageItem;
}

/**
 * Split sink so that:
 *  - Bedrock keeps its current ordering (persist batch → per-tool emit →
 *    execute → per-tool emit → persist batch) with no behaviour change.
 *  - Kiro persist+emit per event as the ACP subprocess streams them, fixing
 *    the batched UI and reload-history-loss bugs.
 *
 * The default implementation (see default-sink.ts) wires persist calls to
 * `saveToolUseMessage` / `saveToolResultMessage` and emit calls to
 * `sendWebappEvent` — exactly what both loops do today, but now through one
 * seam.
 */
export interface ToolEventSink {
  persistToolUseMessage(
    workerId: string,
    message: Message,
    metadata?: { outputTokenCount?: number; thinkingBudget?: number }
  ): Promise<PersistedToolUse>;

  persistToolResultMessage(workerId: string, message: Message, parentSK: string): Promise<PersistedToolResult>;

  emitToolUseEvent(workerId: string, payload: ToolUseEmit): Promise<void>;

  emitToolResultEvent(workerId: string, payload: ToolResultEmit): Promise<void>;
}

/**
 * Outcome of one successful backend turn. The orchestrator reads these fields
 * to handle Slack / last-message preview / parent redirect / assistant message
 * persistence uniformly across backends.
 */
export interface TurnResult {
  /**
   * The assistant message to persist (role: 'assistant'). Backends that have
   * their own persistence concerns (e.g. Bedrock tracks reasoning blocks and
   * output token counts) set `alreadyPersisted` to true so the orchestrator
   * does not double-save; otherwise the orchestrator calls
   * `saveConversationHistory` on this message.
   */
  assistantMessage: Message;
  /** True if the backend already wrote assistantMessage to DynamoDB. */
  alreadyPersisted: boolean;
  /**
   * Plain text preview used for Slack / lastMessage / parent redirect. For
   * Bedrock this is the last text block with <thinking> tags stripped; for
   * Kiro this is the concatenated agent_message_chunk output.
   */
  previewText: string;
  /** Optional: set to false when the backend exited early (cancellation, bail-out); skips finalization. */
  skipFinalize?: boolean;
  /**
   * When true, the backend has already emitted a `type:'message'` webapp
   * event for the assistant text via its own delivery path (e.g. the
   * Kiro tool-boundary text flush in `kiroAgentLoop`). The orchestrator's
   * `finalizeTurn` therefore MUST NOT re-emit `type:'message'` to the
   * webapp (which would surface as a duplicate bubble — the webapp's
   * `SessionPageClient` does not deduplicate assistant messages by
   * content). Slack / parent-redirect / sidebar / push notification
   * channels are NOT covered by the webapp emit and must still run, so
   * the orchestrator gates only the webapp emit, not the whole
   * finalize. Default `undefined` is treated as `false` everywhere a
   * legacy backend has not opted into the new contract.
   */
  webappMessageAlreadyEmitted?: boolean;
  /**
   * The DynamoDB SK (sort key) of the persisted assistant message. Populated
   * by the backend after `saveConversationHistory` so the orchestrator can
   * include it in the webapp event, enabling the client to assign the correct
   * DOM id to the streamed message (matching the search-result hash target).
   */
  messageSK?: string;
  /** When true, the orchestrator should schedule a delayed re-trigger of the agent loop after finalization. */
  retrigger?: boolean;
  /** Delay in milliseconds before the re-trigger fires. Defaults to 30_000 if omitted. */
  retriggerDelayMs?: number;
  /**
   * Set when the turn ended abnormally (e.g. the backend gave up after a
   * prompt failure) rather than by completing its delegated work. The
   * orchestrator routes this to `notifyTermination` so the PARENT session is
   * woken regardless of what triggered the turn (agentMessage / eventTrigger /
   * systemRetrigger). This closes the gap where a failure on a non-agentMessage
   * turn was silently dropped (finalizeTurn's parent redirect only fires for
   * agentMessage-triggered turns). A normal completion leaves this undefined so
   * the parent is NOT over-woken.
   */
  abnormalTermination?: { reason: string };
  /**
   * Normalised context-window utilisation for the turn, expressed as a
   * percentage in the range [0, 100]. Both backends populate this through a
   * single shared field so it can be surfaced to the model (and logged)
   * backend-agnostically; the model uses it to decide when to hand its work
   * over to a successor session:
   *
   *  - Kiro: the value kiro-cli itself reports via the `_kiro.dev/metadata`
   *    ACP notification (`contextUsagePercentage`). Using kiro-cli's own
   *    number guarantees the worker's view never drifts from what kiro-cli
   *    displays / acts on internally.
   *  - Bedrock: `currentContextTokens / maxInputTokens * 100`, where
   *    `currentContextTokens` is the same running total the agent loop already
   *    tracks for middle-out filtering.
   *
   * `undefined` when the backend could not determine a value this turn (e.g.
   * the Kiro metadata notification never arrived, or a Bedrock turn produced
   * no usage). When unknown, the environment block is simply omitted for the
   * next turn.
   */
  contextUsagePercentage?: number;
}

/**
 * Minimal inference backend contract. A backend:
 *  - decides how to produce a response (Converse API vs ACP subprocess),
 *  - dispatches tool events to the sink in the order its protocol dictates,
 *  - returns a TurnResult so the shared orchestrator can finalize the turn.
 *
 * The orchestrator handles: history / system prompt building, repair of
 * dangling toolUse, Slack send, last-message preview, parent redirect, and
 * outer error handling.
 */
export interface InferenceBackend {
  readonly kind: InferenceMode;
  runTurn(ctx: TurnContext, sink: ToolEventSink): Promise<TurnResult>;
  /** Called from the worker process signal handler on shutdown. */
  dispose?(): Promise<void>;
}
