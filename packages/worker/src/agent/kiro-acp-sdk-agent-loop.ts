/**
 * kiroAcpSdkAgentLoop — ACP-SDK-based Kiro backend loop
 * ==============================================================================
 * Drives `kiro-cli acp` through the official `@agentclientprotocol/sdk` via
 * {@link KiroAcpAgent}. This is the live path — `kiro-backend.ts` calls
 * `kiroAcpSdkAgentLoop` unconditionally, so any change here ships on deploy.
 *
 * The event fan-out (tool_call/tool_call_update → sink) goes through shared
 * pure helpers (`normalizeKiroToolName`, `processToolCallDiscardBoundary`,
 * `resolveToolResultOutput`, `truncateToolOutput`,
 * `shouldSuppressToolUseRedelivery`, the sanitizers), and a shared
 * parameterised unit test exercises those helpers so loop and helpers cannot
 * drift.
 *
 * KiroAcpAgent owns its OWN subprocess + ACP session lifecycle (it does NOT go
 * through the legacy supervisor `reconcileActiveClient`/`ensureSessionStarted`).
 *
 * ## Environment variables (resilience tunables)
 * All are optional; the defaults reproduce the intended production behaviour.
 * Booleans accept `0/false/off/no` (case-insensitive) to disable; anything else
 * (or unset) is the stated default. Millisecond values fall back to the default
 * when unset/empty/non-numeric/negative; `0` disables the associated timeout.
 *
 *   Failure-class retry ladder:
 *     KIRO_ACP_RETRY_MAX_PER_CLASS   (int, default 3)   max in-turn retries per failure class
 *     KIRO_ACP_RETRY_MAX_TOTAL       (int, default 6)   turn-wide cap across all classes
 *     KIRO_ACP_RETRY_EMPTY_RESPONSE  (bool, default off) retry a successful-but-empty response
 *   Non-lethal cancel probe:
 *     KIRO_ACP_CANCEL_PROBE          (bool, default on)  enable the session/cancel liveness probe
 *     KIRO_ACP_CANCEL_ACK_TIMEOUT_MS (ms,  default 5000) bounded wait for the probe ack
 *   /proc liveness:
 *     KIRO_ACP_PROC_LIVENESS         (bool, default on)  enable /proc measurement gating
 *     KIRO_ACP_TOOL_PROBE_INTERVAL_MS(ms,  default 60000) tool-in-flight liveness probe interval (0=off)
 *   Watchdog:
 *     KIRO_ACP_IDLE_TIMEOUT_MS       (ms,  default 600000)  idle watchdog
 *     KIRO_ACP_WALL_CLOCK_HARD_MS    (ms,  default 1800000) hard wall-clock ceiling
 *   Session-setup timeouts:
 *     KIRO_ACP_INITIALIZE_TIMEOUT_MS (ms,  default 120000) outer connect+handshake ceiling
 *     KIRO_ACP_SESSION_NEW_TIMEOUT_MS(ms,  default 30000)  session/new bound
 *     KIRO_ACP_SESSION_LOAD_TIMEOUT_MS(ms, default 120000) session/load bound (MCP re-register)
 *   Turn-to-turn process reuse:
 *     KIRO_ACP_PROCESS_REUSE         (bool, default on)  kill-switch; off = per-turn fresh spawn
 *     KIRO_ACP_PROCESS_MAX_AGE_MS    (ms,  default 21600000 = 6h) max pooled-process age
 *
 * ## Design notes
 *   - Session resume: v3 session files are synthesised from DDB history (with
 *     modelId) before passing sessionId to KiroAcpAgent, which issues
 *     session/load via ManualSession. kiroSessionId is persisted to DDB on the
 *     first successful turn.
 *   - Model runtime switch: mid-session model rotation via
 *     `rotateSessionForModel` (synthesize new session files with the desired
 *     modelId, verify via fabrication guard, persist new sessionId). The user
 *     is notified on failure, with a per-model dedup guard.
 *   - `ctx.environmentBlock` is appended to the system prompt before
 *     buildKiroPromptBlocks so the model sees the context-usage
 *     self-regulation hint; the block is not persisted.
 *   - Initial model selection: modelId is passed into
 *     synthesizeKiroSessionFilesV3 and written to the v3 session.json
 *     metadata. kiro-cli resolves the model from this store on session/load.
 *     The resolveModelConfig precedence logic feeds the synthesis.
 *   - `--trust-all-tools`: the v3 engine rejects this CLI flag. The SDK-path
 *     equivalent is the `session/request_permission` ACP request handler in
 *     kiro-acp-agent.ts, which auto-selects `allow_always` / `allow_once` for
 *     every permission prompt — achieving the same effect without the flag.
 */
import type { ToolEventSink, TurnContext, TurnResult, PersistedToolUse } from '@remote-swe-agents/agent-core/lib';
import { Message } from '@aws-sdk/client-bedrock-runtime';
import {
  getKiroApiKey,
  saveConversationHistory,
  getLatestMessageSK,
  shouldSuppressToolUseRedelivery,
  isMessageDeliveryToolName,
  resolveModelConfig,
  getUserPreferences,
  updateSessionKiroSessionId,
  clearSessionKiroSessionId,
  sendSystemMessage,
} from '@remote-swe-agents/agent-core/lib';
import { INTERNAL_ERROR_MESSAGE_TYPE } from '@remote-swe-agents/agent-core/schema';
import { persistErrorBubble } from './persist-error-bubble';
import { KiroAcpAgent } from './strands/kiro-acp-agent';
import type { KiroAcpPromptInput } from './strands/kiro-acp-agent';
import { randomUUID } from 'node:crypto';
import { synthesizeKiroSessionFilesV3, kiroV3SessionFilesExist, readKiroV3SessionModelId } from './kiro-session-synth';
import { computeSynthPlan } from './compute-synth-plan';
import { rotateSessionForModel, type RotationResult } from './strands/rotate-session-for-model';
import {
  buildKiroPromptBlocks,
  buildAggregatedCurrentTurn,
  normalizeKiroToolName,
  processToolCallDiscardBoundary,
  resolveToolResultOutput,
  isTerminalToolStatus,
  stripThinkBlocks,
  stripLeakedTemplateTokens,
  containsLeakedTemplateTokens,
  buildRecoveryHistorySummary,
  parseActiveProcessPid,
  killStaleKiroProcess,
  waitForStalePidExit,
  getProcessStartTime,
  isPromptTimeoutOrIdleError,
  getKiroPermanentErrorHint,
  isImageDimensionError,
  invalidateKiroSessionFiles,
  isImageReadToolName,
  extractImagePathFromToolInput,
  persistToolReadImage,
  getRetriggerBurstStats,
  computeRetriggerBackoffMs,
  buildRetryFailureResult,
  runImageDimensionRecovery,
  NON_EMPTY_DISCARD_WARNING,
  classifyKiroFailure,
  decideRetryLadder,
  kiroRetryMaxPerClass,
  kiroRetryMaxTotal,
  emptyResponseRetryEnabled,
  EMPTY_RESPONSE_ERROR,
  type KiroFailureClass,
  type ToolBoundaryFlushState,
} from './kiro-loop-helpers';
import { buildKiroMcpServerList } from './kiro-mcp-servers';
import { composeSystemPrompt } from './compose-system-prompt';
import { kiroAgentPool, buildReuseKey, kiroProcessReuseEnabled } from './strands/kiro-agent-pool';

/** Names treated as "sendMessageToUser" for the webappMessageAlreadyEmitted gate. */
const SEND_MESSAGE_TO_USER_NAMES = ['sendMessageToUser', 'Send Message To User', 'Send_Message_To_User'];

/** Why the loop is finalizing the pooled agent for this turn (process reuse). */
export type ReleaseReason = 'ok' | 'cancelled' | 'error';

/**
 * Process-reuse finalize decision (pure): whether the turn's agent should be KEPT in the
 * pool for the next turn or DISPOSED. Kept only on a clean completion, with
 * reuse enabled, a non-fallback session, and a live subprocess; every other
 * case disposes (cancel/error → avoid the -32603 reuse race + history
 * divergence; synthesis-fallback → never persisted; dead → unusable; reuse
 * disabled → kill-switch). Exported so the loop AND its integration test run
 * the SAME decision (no simulation).
 */
export function decideFinalizeAction(
  reason: ReleaseReason,
  ctx: { reuseEnabled: boolean; synthesisFailed: boolean; alive: boolean }
): 'keep' | 'dispose' {
  const keep = reason === 'ok' && ctx.reuseEnabled && !ctx.synthesisFailed && ctx.alive;
  return keep ? 'keep' : 'dispose';
}

/**
 * Dedup guard for model-switch failure notifications (container-lifetime).
 * Maps workerId → the desiredModel label we already notified the user about.
 * Cleared on rotation success so a subsequent failure re-notifies. Mirrors
 * legacy KiroClientState.modelSwitchFailureNotifiedFor.
 */
export const modelSwitchFailureNotifiedFor = new Map<string, string>();

/**
 * Handles the outcome of `rotateSessionForModel` — updates the module-level
 * dedup guard Map and sends user notification on failure (with dedup).
 * Extracted so tests exercise the real if/set/delete wiring without running
 * the full loop (same pattern as WatchdogController extraction).
 */
export async function handleModelSwitchOutcome(opts: {
  rotationResult: RotationResult;
  workerId: string;
  currentSessionId: string;
  desiredLabel: string;
  liveLabel: () => string;
  slackUserId: string | undefined;
  notify: (workerId: string, message: string, persistent: boolean) => Promise<void>;
}): Promise<{ effectiveSessionId: string; notified: boolean }> {
  const { rotationResult, workerId, currentSessionId, desiredLabel, liveLabel, slackUserId, notify } = opts;
  if (rotationResult.ok) {
    modelSwitchFailureNotifiedFor.delete(workerId);
    return { effectiveSessionId: rotationResult.newSessionId, notified: false };
  }
  if (modelSwitchFailureNotifiedFor.get(workerId) !== desiredLabel) {
    modelSwitchFailureNotifiedFor.set(workerId, desiredLabel);
    const live = liveLabel();
    const warn = `⚠️ Could not switch the model to ${desiredLabel} (staying on ${live}): ${rotationResult.reason}`;
    try {
      await notify(workerId, slackUserId ? `<@${slackUserId}> ${warn}` : warn, false);
    } catch (notifyErr) {
      console.warn(
        `[kiro-acp-sdk-loop] failed to notify user about model-switch failure: ${
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr)
        }`
      );
    }
    return { effectiveSessionId: currentSessionId, notified: true };
  }
  return { effectiveSessionId: currentSessionId, notified: false };
}

/**
 * ACP-SDK Kiro loop. Same (ctx, sink) → TurnResult contract as `kiroAgentLoop`.
 */
export const kiroAcpSdkAgentLoop = async (ctx: TurnContext, sink: ToolEventSink): Promise<TurnResult> => {
  const { workerId, cancellationToken, session, systemPrompt, slackUserId } = ctx;
  const senderUserId = ctx.senderUserId;
  const cwd = ctx.cwd;

  const { item: currentTurnItem, consumedTailCount } = buildAggregatedCurrentTurn(ctx.history);
  if (!currentTurnItem || currentTurnItem.role !== 'user') {
    return emptyTurn();
  }
  if (!hasRenderableBlocks(currentTurnItem.content)) {
    return emptyTurn();
  }

  const kiroApiKey = await resolveKiroApiKey(senderUserId, session?.initiator);
  if (!kiroApiKey) {
    return {
      assistantMessage: { role: 'assistant', content: [{ text: 'Kiro API key is not configured.' }] },
      alreadyPersisted: false,
      previewText: 'Kiro API key is not configured.',
      abnormalTermination: { reason: 'kiro-api-key-missing' },
    };
  }

  const mcpServers = await buildKiroMcpServerList({ workerId, customAgent: ctx.customAgent });

  // Resolve the kiro model — same precedence as the legacy loop
  const prefs = senderUserId ? await getUserPreferences(senderUserId) : undefined;
  const lastUserMessage = ctx.history.filter((i) => i.role === 'user').at(-1);
  const perMessageModel = lastUserMessage?.kiroModelOverride;
  const kiroModel = resolveModelConfig({
    overrides: perMessageModel ? { kiroModelOverride: perMessageModel } : undefined,
    session: {
      kiroDefaultModel: session?.kiroDefaultModel,
      kiroModel: session?.kiroModel,
    },
    customAgent: {
      kiroDefaultModel: ctx.customAgent?.kiroDefaultModel,
      kiroModel: ctx.customAgent?.kiroModel,
    },
    userPreferences: prefs
      ? {
          kiroDefaultModel: prefs.kiroDefaultModel,
          kiroModel: prefs.kiroModel,
        }
      : undefined,
  }).kiroModel;
  const modelArg = kiroModel !== 'auto' ? kiroModel : undefined;
  try {
    const sanitized = mcpServers.map((s) => ({ type: s.type, name: s.name }));
    console.log(
      `[kiro-mcp-debug] mcpServers for ACP-SDK turn workerId=${workerId} count=${mcpServers.length} list=${JSON.stringify(sanitized)}`
    );
  } catch (e) {
    console.warn('[kiro-mcp-debug] failed to log mcpServers:', e);
  }

  // ---- Session synthesis + resume (v3 only) ---------------------------------
  // Resolve or generate a kiro sessionId. On the first turn (no persisted id),
  // a new UUID is minted. On subsequent turns, resume the persisted session.
  const sessionCwd = cwd;
  const persistedKiroSessionId = session?.kiroSessionId;
  let effectiveSessionId = persistedKiroSessionId ?? randomUUID();
  const modelIdForSynth = modelArg; // undefined = auto (omitted from session.json)
  let synthesisFailed = false;

  const makeAgent = () =>
    new KiroAcpAgent({
      cwd,
      apiKey: kiroApiKey,
      agentName: ctx.kiroAgentName,
      trustAllTools: true,
      mcpServers,
      model: modelArg,
      ...(synthesisFailed ? {} : { sessionId: effectiveSessionId }),
    });

  // ---- Turn-to-turn process reuse --------------------------------------------
  // Before the per-turn spawn→synth→load→dispose cycle, try to reuse the live
  // kiro-cli subprocess kept from the previous turn. A reuse HIT skips the
  // whole cold setup (session synthesis, model rotation, and session/load) and
  // prompts the same in-memory ACP session directly — the process already holds
  // the conversation, so re-synthesising from DDB is unnecessary and is the
  // demoted recovery path. Reuse requires a persisted sessionId (turn ≥ 2); the
  // pool key includes the rewind fingerprint so a webapp rewind/undo forces a
  // recycle → cold synth+load from the rewind-filtered history.
  // Build the reuse key from the CURRENT effective state. The MCP
  // config, API key and cwd are folded in so any change forces a recycle;
  // the key is recomputed via this closure so the finalize/store path uses
  // the EFFECTIVE sessionId/model after synthesis + model rotation, not the
  // stale turn-entry values.
  const currentReuseKey = () =>
    buildReuseKey({
      workerId,
      sessionId: effectiveSessionId,
      model: modelArg,
      agentName: ctx.kiroAgentName,
      mcpServers,
      apiKey: kiroApiKey,
      cwd: sessionCwd,
      rewindState: session?.rewindState,
    });
  // The acquire key must match what a PRIOR turn stored, which used that turn's
  // persisted sessionId. On turn ≥ 2 effectiveSessionId === persistedKiroSessionId
  // here (reuse only runs when persisted), so currentReuseKey() is the right
  // lookup key.
  let agent: KiroAcpAgent | undefined;
  let reused = false;
  if (kiroProcessReuseEnabled() && persistedKiroSessionId) {
    const acquired = (await kiroAgentPool.tryAcquire(currentReuseKey())) as KiroAcpAgent | undefined;
    if (acquired) {
      agent = acquired;
      reused = true;
      effectiveSessionId = persistedKiroSessionId;
      console.log(
        `[kiro-acp-sdk-loop] process reuse: prompting existing session ${effectiveSessionId} (no synth/load)`
      );
    }
  }

  if (!reused) {
    await runColdSessionSetup();
    // Cache the freshly-started agent for the next turn's reuse (only when
    // synthesis did not fall back to a fresh random id — a fabrication-fallback
    // session has no persisted id yet). The key is recomputed HERE with the
    // effective (post-synth / post-rotation) sessionId + model, so turn 1 no
    // longer stores under an empty-sessionId key that guarantees a turn-2 miss.
    if (kiroProcessReuseEnabled() && !synthesisFailed && agent) {
      await kiroAgentPool.store(currentReuseKey(), agent);
    }
  }

  if (!agent) {
    // Defensive: both branches always assign `agent`. This guard narrows the
    // type for the rest of the loop and fails loudly if that invariant breaks.
    throw new Error('[kiro-acp-sdk-loop] internal error: agent not initialised after session setup');
  }

  // Cold-path session setup extracted into a closure so the reuse branch can
  // skip it entirely. Mutates `agent` / `effectiveSessionId` / `synthesisFailed`
  // in the enclosing scope (same as the original inline code).
  async function runColdSessionSetup(): Promise<void> {
    // v3 pre-load synthesis guard: synthesize session files from DDB history
    // BEFORE passing sessionId to KiroAcpAgent (which issues session/load).
    // Without this, v3's session/load silently fabricates an empty session for an
    // unknown id (the "unknown-ID hazard"). By writing files first, load finds
    // them and restores conversation memory. On turn 1 (empty history after trim),
    // synthesis still writes session.json with modelId — this ensures the initial
    // model selection takes effect from the first turn and prevents the v3
    // silent-fabrication hazard for unknown session IDs.
    if (!kiroV3SessionFilesExist(effectiveSessionId, sessionCwd)) {
      const { itemsToSynth, rawCount, replayTrimCount } = computeSynthPlan(ctx.history, consumedTailCount);
      try {
        const synth = await synthesizeKiroSessionFilesV3({
          sessionId: effectiveSessionId,
          cwd: sessionCwd,
          items: itemsToSynth,
          modelId: modelIdForSynth,
        });
        console.log(
          `[kiro-acp-sdk-loop] v3 session synthesised: ${synth.events.length} events for ${effectiveSessionId} ` +
            `(rawHistoryItems=${rawCount}, trimmed=${replayTrimCount}, itemsToSynth=${itemsToSynth.length})`
        );
      } catch (synthErr) {
        console.error(
          `[kiro-acp-sdk-loop] v3 session synthesis failed for ${effectiveSessionId}:`,
          synthErr instanceof Error ? synthErr.message : synthErr
        );
        // D2: fall back to a fresh session with condensed history injected into
        // the system prompt (legacy 'new-after-recovery-failure' pattern). The model
        // gets enough context to continue naturally instead of acting like first contact.
        synthesisFailed = true;
        effectiveSessionId = randomUUID();
        if (persistedKiroSessionId) {
          try {
            await clearSessionKiroSessionId(workerId);
          } catch (clearErr) {
            console.error('[kiro-acp-sdk-loop] failed to clear kiroSessionId after synth failure:', clearErr);
          }
        }
      }
    }

    // ---- Mid-session model rotation (legacy applyDesiredModel parity) ----------
    // When a per-message model override changes the desired model from what was
    // previously stored in the session, we rotate: re-synthesize under a fresh
    // sessionId carrying the new modelId, then use that for the agent constructor.
    // On rotation failure, the turn proceeds on the previous model and the user is
    // notified (with dedup guard, legacy parity).
    if (!synthesisFailed && persistedKiroSessionId) {
      const rotationResult = await rotateSessionForModel(
        {
          workerId,
          currentSessionId: effectiveSessionId,
          desiredModel: modelArg,
          history: ctx.history,
          consumedTailCount,
          cwd: sessionCwd,
        },
        {
          synthesize: synthesizeKiroSessionFilesV3,
          readModelId: readKiroV3SessionModelId,
          sessionFilesExist: kiroV3SessionFilesExist,
          persistSessionId: (wid, sid) => updateSessionKiroSessionId(wid, sid),
          generateSessionId: () => randomUUID(),
        }
      );
      const outcome = await handleModelSwitchOutcome({
        rotationResult,
        workerId,
        currentSessionId: effectiveSessionId,
        desiredLabel: modelArg ?? 'auto',
        liveLabel: () => readKiroV3SessionModelId(effectiveSessionId, sessionCwd) ?? 'auto',
        slackUserId,
        notify: sendSystemMessage,
      });
      effectiveSessionId = outcome.effectiveSessionId;
    }

    agent = makeAgent();

    // Separate the session start (load) phase from the prompt phase.
    // Only load-phase failures clear the persisted kiroSessionId (stale-ID recovery).
    // Prompt-phase failures (tool errors, network transients) leave the session intact
    // — the native session continuity outperforms DDB-based re-synthesis for those.
    //
    // Stale-pid recovery (Option C, legacy parity): if session/load fails with a
    // "Session is active in another process (PID N)" error, attempt to kill the
    // stale process and retry once. v3 is lock-free so this path
    // is normally dormant; it covers future v3 locking or D3 v2+SDK reachability.
    try {
      await agent.start();
    } catch (startErr) {
      const errMsg = startErr instanceof Error ? startErr.message : String(startErr);
      const stalePid = parseActiveProcessPid(errMsg);

      if (stalePid !== undefined) {
        const livePid = agent.getPid();
        const killResult = killStaleKiroProcess(stalePid, { livePid, startTimeLookup: getProcessStartTime });

        if (killResult === 'killed') {
          const exited = await waitForStalePidExit(stalePid);
          if (exited) {
            // Stale process cleared — dispose old agent and retry with a fresh one.
            await agent.dispose();
            agent = makeAgent();
            try {
              await agent.start();
              console.log(`[kiro-acp-sdk-loop] session start recovered after killing stale pid=${stalePid}`);
            } catch (retryErr) {
              // Retry failed — fall through to D5 clear + throw
              if (persistedKiroSessionId) {
                try {
                  await clearSessionKiroSessionId(workerId);
                } catch {}
              }
              await agent.dispose();
              throw retryErr;
            }
          } else {
            // PID did not exit — rotate to fresh session
            if (persistedKiroSessionId) {
              try {
                await clearSessionKiroSessionId(workerId);
              } catch {}
            }
            await agent.dispose();
            throw startErr;
          }
        } else if (killResult === 'gone') {
          // Process already gone — retry directly
          await agent.dispose();
          agent = makeAgent();
          try {
            await agent.start();
            console.log(`[kiro-acp-sdk-loop] session start recovered (stale pid=${stalePid} already gone)`);
          } catch (retryErr) {
            if (persistedKiroSessionId) {
              try {
                await clearSessionKiroSessionId(workerId);
              } catch {}
            }
            await agent.dispose();
            throw retryErr;
          }
        } else {
          // refused-self or refused-other — cannot clear lock, rotate session
          if (persistedKiroSessionId) {
            try {
              await clearSessionKiroSessionId(workerId);
            } catch {}
          }
          await agent.dispose();
          throw startErr;
        }
      } else {
        // No stale PID detected — standard D5 self-healing
        if (persistedKiroSessionId) {
          try {
            await clearSessionKiroSessionId(workerId);
            console.warn(
              `[kiro-acp-sdk-loop] session start/load failed with persisted kiroSessionId=${persistedKiroSessionId}; ` +
                `cleared for self-healing on next turn: ${errMsg}`
            );
          } catch (clearErr) {
            console.error('[kiro-acp-sdk-loop] failed to clear stale kiroSessionId:', clearErr);
          }
        }
        await agent.dispose();
        throw startErr;
      }
    }
  } // end runColdSessionSetup

  // ---- fan-out state (mirrors kiroAgentLoop) --------------------------------
  const inFlight = new Map<
    string,
    { toolName: string; persisted: PersistedToolUse; hadNonEmptyDiscard: boolean; rawInput: unknown }
  >();
  const suppressedRedeliveryToolCallIds = new Set<string>();
  const flushState: ToolBoundaryFlushState = { bufferedRawText: '', discardedRawSoFar: '' };
  let sendMessageToUserCalled = false;
  // Tool-activity guard: whether the CURRENT attempt has persisted any toolUse (performed tool
  // activity). If it has and the attempt then fails, an in-turn retry would
  // blindly re-execute those side effects, so the ladder declines to retry and
  // hands off to the cross-turn auto-retrigger (history re-synthesis) instead.
  // Reset per attempt in resetFanoutForAttempt.
  let toolActivityThisAttempt = false;

  // Serialise sink dispatch so a tool_call_update never lands before its
  // tool_call persist completes (same guarantee as the legacy loop's chain).
  let chain: Promise<void> = Promise.resolve();

  const handleToolCall = async (toolCallId: string, rawTitle: string, kind: string, rawInput: unknown) => {
    // Flag tool activity SYNCHRONOUSLY the moment a tool_call is
    // dispatched, BEFORE any await. `canReprompt` (read synchronously by the
    // probe / delayed-ack path) must observe this immediately — otherwise
    // a stop('cancelled') arriving right after a tool_call but before the async
    // persist completes would read a stale `false` and re-prompt a session
    // whose tool side effects already fired (the exact double-execution
    // guards against).
    toolActivityThisAttempt = true;
    const hadNonEmptyDiscard = flushState.bufferedRawText.trim().length > 0;
    processToolCallDiscardBoundary(flushState);

    const toolName = normalizeKiroToolName(rawTitle || kind);
    if (SEND_MESSAGE_TO_USER_NAMES.includes(toolName)) {
      sendMessageToUserCalled = true;
    }

    // Near-duplicate message-delivery re-delivery suppression (fail-open).
    if (isMessageDeliveryToolName(toolName)) {
      const candidateMessage = (rawInput as { message?: unknown } | undefined)?.message;
      if (typeof candidateMessage === 'string') {
        let suppress = false;
        try {
          suppress = await shouldSuppressToolUseRedelivery(workerId, candidateMessage);
        } catch (e) {
          console.error('[kiro-acp-sdk-loop] redelivery dedup check failed; persisting anyway:', e);
        }
        if (suppress) {
          suppressedRedeliveryToolCallIds.add(toolCallId);
          console.warn(
            `[kiro-acp-sdk-loop] Suppressing near-duplicate ${toolName} toolUse persist+emit for ${workerId} ` +
              `(likely auto-retrigger re-emit; first 80 chars="${candidateMessage.slice(0, 80).replace(/\s+/g, ' ')}")`
          );
          return;
        }
      }
    }

    const toolUseMsg: Message = {
      role: 'assistant',
      // Bedrock's DocumentType accepts arbitrary JSON-compatible values;
      // rawInput from ACP is structurally compatible (matches legacy loop).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: [{ toolUse: { toolUseId: toolCallId, name: toolName, input: (rawInput ?? {}) as any } }],
    };
    const persisted = await sink.persistToolUseMessage(workerId, toolUseMsg);
    // Tool activity is already flagged synchronously at dispatch (see above);
    // this remains a harmless idempotent re-assert on the post-persist path.
    toolActivityThisAttempt = true;
    inFlight.set(toolCallId, { toolName, persisted, hadNonEmptyDiscard, rawInput });
    await sink.emitToolUseEvent(workerId, {
      toolUseId: toolCallId,
      toolName,
      input: rawInput ?? {},
      messageSK: persisted.SK,
    });
  };

  const handleToolResult = async (toolCallId: string, status: string, rawTitle: string, output: string | undefined) => {
    // ACP tool_call_update carries a status lifecycle: pending → in_progress →
    // completed | failed. Persist + emit ONLY on terminal states — identical to
    // the legacy loop (kiro-agent-loop.ts). Without this guard the v2 initial
    // `status=''` update and the v3 `in_progress` updates (v3 emits 3 updates:
    // in_progress×2 → completed) would each early-persist a
    // placeholder + delete the inFlight entry, so the real `completed` output
    // never lands in DDB and the toolResult event double-emits. Drop
    // non-terminal updates here, before any other processing (order matches
    // the legacy loop: terminal guard first, redelivery-suppression second).
    if (!isTerminalToolStatus(status)) {
      return;
    }
    if (suppressedRedeliveryToolCallIds.has(toolCallId)) {
      suppressedRedeliveryToolCallIds.delete(toolCallId);
      return;
    }
    const tracked = inFlight.get(toolCallId);
    const toolName = tracked?.toolName || normalizeKiroToolName(rawTitle || '');
    const resolved = resolveToolResultOutput(status, output);

    const toolResultMsg: Message = {
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: toolCallId,
            content: [{ text: resolved }],
            ...(status === 'failed' ? { status: 'error' as const } : {}),
          },
        },
      ],
    };
    // Persist tool-read images to S3 so session re-synthesis can recover
    // visual context. Capture runs BEFORE the toolResult persist so the injected
    // image block lands in DDB (that block is the actual recovery mechanism); the
    // resized S3 key is also carried on the live emit (imageKeys) for the webapp.
    // Terminal-success only (status === 'completed'), once per toolUseId (the
    // inFlight entry is deleted right after persist), best-effort (capture failure
    // must never break the tool result). Ported from the Bedrock loop's image recovery.
    let imageKeys: string[] | undefined;
    if (tracked && status === 'completed' && isImageReadToolName(toolName)) {
      const imagePath = extractImagePathFromToolInput(toolName, tracked.rawInput);
      if (imagePath) {
        const captured = await persistToolReadImage(workerId, imagePath);
        if (captured) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          toolResultMsg.content![0]!.toolResult!.content!.push(captured.block as any);
          imageKeys = [captured.s3Key];
        }
      }
    }
    if (tracked) {
      if (tracked.hadNonEmptyDiscard) {
        toolResultMsg.content![0]!.toolResult!.content!.push({ text: NON_EMPTY_DISCARD_WARNING });
      }
      await sink.persistToolResultMessage(workerId, toolResultMsg, tracked.persisted.SK);
      inFlight.delete(toolCallId);
    }
    await sink.emitToolResultEvent(workerId, {
      toolUseId: toolCallId,
      toolName,
      output: resolved,
      ...(imageKeys ? { imageKeys } : {}),
    });
  };

  const onChunk = (chunkText: string) => {
    if (chunkText.length > 0) flushState.bufferedRawText += chunkText;
  };

  // Cancellation: map the worker cancellation token to the agent AbortSignal.
  const abort = new AbortController();
  const unsub = cancellationToken.onCancel(() => abort.abort());

  // Tear-down / hand-off of the agent at every turn-exit point. On a clean
  // completion ('ok') with reuse enabled and a healthy process, the agent is
  // KEPT in the pool for the next turn (no dispose). On cancellation or error,
  // or when reuse is disabled / the process died, it is disposed and the pool
  // slot cleared so the next turn cold starts. A synthesis-fallback session
  // (random id, not persisted) is never pooled.
  //
  // 'ok' stores under currentReuseKey() (effective sessionId/model);
  // the dispose branch is UNCONDITIONAL — even a subprocess that reports
  // !isAlive() must have dispose() called so closeConnection fires and the
  // connectWith callback promise is not left pending (a micro-leak). dispose()
  // is idempotent. store()/clear() themselves dispose any DIFFERENT cached
  // entry, so we only dispose `a` directly when it is NOT the cached entry.
  const finalizeAgent = async (reason: ReleaseReason): Promise<void> => {
    const a = agent;
    if (!a) return;
    const action = decideFinalizeAction(reason, {
      reuseEnabled: kiroProcessReuseEnabled(),
      synthesisFailed,
      alive: a.isAlive(),
    });
    if (action === 'keep') {
      await kiroAgentPool.store(currentReuseKey(), a);
      return;
    }
    if (kiroAgentPool.isCached(a)) {
      await kiroAgentPool.clear();
    } else {
      await a.dispose();
    }
  };

  const promptBlocks = await buildKiroPromptBlocks({
    systemPrompt: (() => {
      let effective = composeSystemPrompt(systemPrompt, ctx.environmentBlock);
      // D2: inject condensed history summary when synthesis failed (recovery fallback)
      if (synthesisFailed && ctx.history.length > 0) {
        const summary = buildRecoveryHistorySummary(ctx.history);
        if (summary.length > 0) {
          effective = effective + summary;
          console.error(
            `[kiro-acp-sdk-loop] RECOVERY_HISTORY_INJECTED workerId=${workerId} ` +
              `historyItems=${ctx.history.length} summaryChars=${summary.length}`
          );
        }
      }
      return effective;
    })(),
    currentTurnItem,
  });

  // Reset the per-attempt fan-out state so a respawned attempt does not
  // inherit a half-streamed response (buffered text / open tool ids) from the
  // failed attempt.
  //
  // The buffer/in-flight reset is ENQUEUED onto the existing `chain`
  // rather than clobbering it with `Promise.resolve()`. Clobbering would let a
  // still-running persist from the aborted attempt write into DDB / mutate
  // `inFlight` AFTER we cleared it, corrupting the next attempt's bookkeeping.
  // Appending the clear to the tail of the chain lets all prior dispatched
  // persists settle first. `resetTools` (default true) preserves the double-execution guard: a fresh
  // subprocess attempt clears toolActivityThisAttempt, but an in-session
  // reprompt (onReset) must NOT (it re-runs the SAME session, so prior tool
  // side effects still count against the tool-activity guard). The returned promise lets
  // callers await the drained reset when ordering matters.
  const resetFanoutForAttempt = (opts?: { resetTools?: boolean }): Promise<void> => {
    const resetTools = opts?.resetTools ?? true;
    chain = chain
      .catch(() => {})
      .then(() => {
        flushState.bufferedRawText = '';
        flushState.discardedRawSoFar = '';
        inFlight.clear();
        suppressedRedeliveryToolCallIds.clear();
        if (resetTools) toolActivityThisAttempt = false;
      });
    return chain;
  };

  // The alive-cancelled reset (onReset) re-prompts the SAME session,
  // so tool side effects from the aborted attempt are still live — do NOT clear
  // toolActivityThisAttempt here (only a fresh-subprocess attempt resets it).
  const onResetInSession = () => {
    void resetFanoutForAttempt({ resetTools: false });
  };

  // Retry-failure handling is the extracted, unit-tested `buildRetryFailureResult`
  // (kiro-loop-helpers): fast-fail on a repeat image error (no retrigger burst,
  // below), else transparent auto-retrigger, else give-up bubble. Injected
  // deps keep the fast-fail / giveup-bubble logic testable against real code.
  // Every permanent SURFACE inside buildRetryFailureResult persists the
  // user-facing bubble (fast-fail + giveup) and returns its messageSK.
  const handleRetryFailure = (retryMsg: string, originalMsg: string): Promise<TurnResult> =>
    buildRetryFailureResult(
      {
        workerId,
        unsub,
        persistErrorBubble,
        saveConversationHistory,
        getRetriggerBurstStats,
        computeRetriggerBackoffMs,
      },
      retryMsg,
      originalMsg
    );

  // Shared prompt dispatcher so the initial attempt AND every recovery/retry
  // attempt (retry-ladder respawn + image recovery) use identical event
  // fan-out wiring and the SAME onReset/canReprompt hooks (no drift between
  // paths). Rebuilt per attempt via the serialised `chain` closure so a
  // respawn starts from a clean stream; `tag` labels the dispatch in logs.
  const runPromptOnce = (agentInstance: KiroAcpAgent, tag: string) =>
    agentInstance.promptCompat(
      promptBlocks as unknown as KiroAcpPromptInput,
      onChunk,
      (event) => {
        chain = chain
          .then(() =>
            event.type === 'tool_call'
              ? handleToolCall(
                  event.toolCall.toolCallId,
                  event.toolCall.title,
                  event.toolCall.kind,
                  event.toolCall.rawInput
                )
              : handleToolResult(event.toolCallId, event.status, event.title, event.output)
          )
          .catch((e) => {
            console.error(`[kiro-acp-sdk-loop] sink dispatch failed (${tag}):`, e);
          });
      },
      {
        cancelSignal: abort.signal,
        // On an alive-cancelled re-prompt, discard this attempt's
        // partial fan-out (buffered text / open tool ids) so the re-streamed
        // turn is not double-counted — but KEEP toolActivityThisAttempt, since
        // the reprompt reuses the SAME session and prior tool side effects are
        // still live (the double-execution guard must still see them).
        onReset: onResetInSession,
        // Veto an alive-cancelled in-session re-prompt when this attempt
        // already performed tool activity — re-running the same prompt would
        // re-execute those side effects (new toolCallId → double persist). The
        // agent then surfaces a wedge → ladder giveup → cross-turn auto-retrigger
        // (history re-synthesis), symmetric with the ladder's tool-activity guard.
        canReprompt: () => !toolActivityThisAttempt,
      }
    );

  // ---- Failure-class-aware in-turn retry ladder ------------------------------
  // Replaces the previous "retry once for any non-permanent error" with an
  // independent per-class budget (KIRO_ACP_RETRY_MAX_PER_CLASS, default 3).
  // Each turn is one loop invocation, so the counters reset automatically on
  // turn completion. Only after a class exhausts its in-turn budget do we fall
  // through to the existing cross-turn, time-budgeted auto-retrigger — the two
  // layers are complementary (immediate fresh-subprocess retry vs delayed
  // cross-turn re-queue), so this preserves the auto-retrigger contract and
  // the orchestrator stays unchanged. Session is preserved throughout
  // (prompt-phase narrowing): kiroSessionId is never cleared here.
  let result: import('@remote-swe-agents/agent-core/lib').KiroPromptResult | undefined;
  const retryCounts: Partial<Record<KiroFailureClass, number>> = {};
  const maxPerClass = kiroRetryMaxPerClass();
  const maxTotal = kiroRetryMaxTotal();
  const emptyResponseEnabled = emptyResponseRetryEnabled();
  let retryAttempted = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      result = await runPromptOnce(agent!, retryAttempted ? 'ladder-retry' : 'initial');

      // Empty-response class: when enabled, treat a successful-but-empty
      // response (end_turn, not cancelled, no renderable text — after the
      // discard/think/template scrubbing the finalize step also applies) as a
      // ladder failure so it re-prompts on a fresh subprocess. Default OFF:
      // an intentional silent turn is a designed normal behaviour here.
      if (
        emptyResponseEnabled &&
        !cancellationToken.isCancelled &&
        result.stopReason !== 'cancelled' &&
        result.toolCalls.length === 0 &&
        isEffectivelyEmptyResponse(result.text, flushState.discardedRawSoFar, flushState.bufferedRawText)
      ) {
        throw new Error(EMPTY_RESPONSE_ERROR);
      }

      break; // success
    } catch (promptErr) {
      const promptMsg = promptErr instanceof Error ? promptErr.message : String(promptErr);

      // Quiesce the fan-out chain BEFORE classifying/deciding. tool_call
      // persists run on the serialized `chain`; a prompt that dies right after
      // a tool_call dispatch (process-died / rejection / hard-wall) may still
      // have an in-flight persist that has not yet set toolActivityThisAttempt.
      // Draining here makes toolActivityThisAttempt authoritative for the tool-activity
      // guard, guarantees any pending toolUse persist completed before an
      // in-turn retry re-executes the tool, and orders the error persist below
      // AFTER the tool writes (so DDB write order is not scrambled).
      await chain.catch(() => {});

      // If the user cancelled during/around the failure, do NOT retry or
      // re-run a cancelled turn on a fresh subprocess — surface an empty turn
      // (the orchestrator suppresses it) and let finalize dispose the agent.
      if (cancellationToken.isCancelled) {
        unsub();
        await finalizeAgent('cancelled');
        return emptyTurn();
      }

      const cls = classifyKiroFailure(promptMsg);
      const decision = decideRetryLadder(cls, retryCounts, {
        maxPerClass,
        maxTotal,
        emptyResponseEnabled,
        toolActivityThisAttempt,
      });

      if (decision === 'permanent') {
        // Image-dimension errors classify as permanent for the ladder,
        // but are recoverable within the SAME turn by invalidating the on-disk
        // session files and re-synthesising from DDB (the re-synthesis degrades
        // oversized images to text placeholders so the constraint is no longer
        // violated). Ported from the Bedrock loop's image recovery. Ordering: dispose
        // BEFORE invalidate so kiro-cli cannot flush its in-memory session back
        // to disk after deletion (SIGTERM flush race). kiroSessionId
        // (effectiveSessionId / persisted) is NOT cleared — it is the id
        // the re-synthesis writes to, and clearing it would lose memory.
        if (isImageDimensionError(promptMsg)) {
          console.log(
            `[kiro-acp-sdk-loop] image validation error — attempting same-turn recovery: ${promptMsg.slice(0, 300)}`
          );
          // Orchestration (dispose→invalidate→resynth→fresh agent→retry once) is
          // the extracted, unit-tested `runImageDimensionRecovery`. effectiveId
          // is the authoritative in-use id this loop tracks (never cleared).
          const outcome = await runImageDimensionRecovery<import('@remote-swe-agents/agent-core/lib').KiroPromptResult>(
            {
              effectiveSessionId,
              cwd: cwd || '/tmp',
              // Clear the pool slot (not a bare dispose) so a poisoned reused
              // process is never handed to the next turn.
              dispose: () => finalizeAgent('error'),
              invalidate: invalidateKiroSessionFiles,
              resynth: async (sid, scwd) => {
                const { itemsToSynth } = computeSynthPlan(ctx.history, consumedTailCount);
                await synthesizeKiroSessionFilesV3({
                  sessionId: sid,
                  cwd: scwd,
                  items: itemsToSynth,
                  modelId: modelArg,
                });
              },
              startFreshAgent: async () => {
                agent = makeAgent();
                await agent.start();
                // Reset the per-attempt fan-out BEFORE the recovery
                // retry streams, symmetric with the ladder respawn (see the
                // `decision === 'retry'` path). Awaited so the fresh attempt
                // starts from drained buffers / cleared in-flight bookkeeping
                // — otherwise the failed attempt's partial fan-out would
                // bleed into the recovery retry.
                await resetFanoutForAttempt();
              },
              runPrompt: () => runPromptOnce(agent!, 'image-recovery-retry'),
            }
          );
          if (outcome.kind === 'start-failed') {
            unsub();
            await finalizeAgent('error');
            throw outcome.error;
          }
          if (outcome.kind === 'retry-failed') {
            const retryMsg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
            await finalizeAgent('error');
            // Fast-fails when retryMsg is itself an image dimension error
            // (persists the bubble, no retrigger burst), else funnels to the
            // auto-retrigger / giveup-bubble path. handleRetryFailure calls
            // unsub() internally.
            return await handleRetryFailure(retryMsg, promptMsg);
          }
          result = outcome.result;
          // Recovery retry succeeded — continue to the completion path.
          break;
        }

        // Non-image permanent error: surface immediately (no retry, no
        // retrigger). Persist the user-facing notification as an
        // 'assistant' bubble so it survives page reload, and deliver
        // sendSystemMessage with the SAME messageSK (main parity e44b8507).
        const hint = getKiroPermanentErrorHint(promptMsg);
        const userNotification = `An error occurred. Retrying will not resolve this error, so processing has stopped.\n\nCause: ${hint}\n\nDetails: ${promptMsg.slice(0, 500)}`;
        const messageSK = await persistErrorBubble(workerId, userNotification);
        await sendSystemMessage(workerId, userNotification, true, false, messageSK);
        const errorMessage: Message = { role: 'assistant', content: [{ text: userNotification }] };
        await saveConversationHistory(workerId, errorMessage, 0, INTERNAL_ERROR_MESSAGE_TYPE);
        unsub();
        await finalizeAgent('error');
        return {
          assistantMessage: errorMessage,
          alreadyPersisted: true,
          previewText: userNotification,
          messageSK,
          abnormalTermination: { reason: userNotification },
        };
      }

      if (decision === 'giveup') {
        // In-turn budget exhausted for this class — hand off to the cross-turn
        // auto-retrigger path via the shared, unit-tested handleRetryFailure
        // (buildRetryFailureResult): fast-fail on a repeat image error, else a
        // transparent auto-retrigger within the time budget, else the give-up
        // bubble. Both the fast-fail and give-up surfaces persist the
        // user-facing bubble + return its messageSK. handleRetryFailure calls
        // unsub() internally. Session preserved: kiroSessionId NOT cleared.
        console.error(
          `[kiro-acp-sdk-loop] retry ladder exhausted for class=${cls} ` +
            `(used=${retryCounts[cls] ?? 0}/${maxPerClass}): ${promptMsg.slice(0, 300)}`
        );
        await finalizeAgent('error');
        return await handleRetryFailure(promptMsg, promptMsg);
      }

      // decision === 'retry': record the attempt, dispose the wedged/dead
      // subprocess, respawn a fresh one, and re-attempt within this turn.
      retryCounts[cls] = (retryCounts[cls] ?? 0) + 1;
      retryAttempted = true;
      if (isPromptTimeoutOrIdleError(promptMsg)) {
        console.warn(`[kiro-acp-sdk-loop] watchdog fired, disposing before retry: ${promptMsg.slice(0, 200)}`);
      }
      console.log(
        `[kiro-acp-sdk-loop] prompt error (class=${cls}, attempt ${retryCounts[cls]}/${maxPerClass}), ` +
          `retrying on fresh subprocess: ${promptMsg.slice(0, 200)}`
      );
      // Mid-turn respawn: tear down the failed agent (and clear the pool slot
      // if it was the cached one) before spawning a fresh subprocess. Await the
      // fan-out reset so the fresh attempt starts from clean bookkeeping.
      await finalizeAgent('error');
      await resetFanoutForAttempt();
      agent = makeAgent();
      try {
        await agent.start();
      } catch (startErr) {
        unsub();
        await finalizeAgent('error');
        throw startErr;
      }
      // Fresh subprocess ready — loop back and re-attempt the prompt within
      // this turn (retry ladder). retryAttempted flips the runPromptOnce log tag.
    }
  }

  // If the success-path body throws (e.g. a DDB persist failure), the CLI's
  // in-memory history and DDB have diverged — the pooled process must NOT be
  // reused as-is. Track it so the finally disposes ('error') instead of caching.
  let successPathThrew = false;
  try {
    await chain;

    if (cancellationToken.isCancelled || result!.stopReason === 'cancelled') {
      return emptyTurn();
    }

    // Tool-boundary discard subtraction (same invariant as the legacy loop).
    const rawResponseText = result!.text.startsWith(flushState.discardedRawSoFar)
      ? result!.text.slice(flushState.discardedRawSoFar.length)
      : flushState.bufferedRawText;

    let responseText = stripThinkBlocks(rawResponseText);
    if (containsLeakedTemplateTokens(responseText)) {
      responseText = stripLeakedTemplateTokens(responseText);
    }

    if (responseText.trim().length === 0) {
      return emptyTurn();
    }

    const responseMessage: Message = { role: 'assistant', content: [{ text: responseText }] };
    const latestSK = await getLatestMessageSK(workerId);
    const savedItem = await saveConversationHistory(workerId, responseMessage, 0, 'assistant', undefined, {
      ensureAfterSK: latestSK,
    });

    // Persist the kiro sessionId so subsequent turns resume this session.
    if (!persistedKiroSessionId) {
      try {
        await updateSessionKiroSessionId(workerId, effectiveSessionId);
      } catch (e) {
        console.warn('[kiro-acp-sdk-loop] failed to persist kiroSessionId; next turn will create fresh:', e);
      }
    }

    return {
      assistantMessage: responseMessage,
      alreadyPersisted: true,
      previewText: responseText,
      contextUsagePercentage: result!.contextUsagePercentage,
      messageSK: savedItem.SK,
      webappMessageAlreadyEmitted: sendMessageToUserCalled,
    };
  } catch (finalizeErr) {
    // A throw from the success body (DDB persist etc.) means DDB and the
    // CLI's in-memory session may have diverged → do not reuse this process.
    successPathThrew = true;
    throw finalizeErr;
  } finally {
    unsub();
    // Keep the healthy process for the next turn on a clean completion;
    // dispose + recycle on cancellation (the cancelled prompt may still be
    // settling at the kiro-cli level → reuse would risk the -32603 race) or on
    // a success-path throw (DDB/CLI history divergence).
    const cancelled = cancellationToken.isCancelled || result?.stopReason === 'cancelled';
    await finalizeAgent(cancelled ? 'cancelled' : successPathThrew ? 'error' : 'ok');
  }
};

/**
 * Empty-response retry: reproduce the finalize step's text derivation to decide
 * whether a successful prompt produced NO renderable text. Mirrors the
 * tool-boundary discard subtraction + think/template scrubbing applied in the
 * success path, so the ladder's empty check and the eventual `emptyTurn()`
 * short-circuit agree. Used only when `KIRO_ACP_RETRY_EMPTY_RESPONSE` is on.
 */
function isEffectivelyEmptyResponse(resultText: string, discardedRawSoFar: string, bufferedRawText: string): boolean {
  const rawResponseText = resultText.startsWith(discardedRawSoFar)
    ? resultText.slice(discardedRawSoFar.length)
    : bufferedRawText;
  let responseText = stripThinkBlocks(rawResponseText);
  if (containsLeakedTemplateTokens(responseText)) {
    responseText = stripLeakedTemplateTokens(responseText);
  }
  return responseText.trim().length === 0;
}

/** Empty/short-circuit turn result (skipFinalize). */
function emptyTurn(): TurnResult {
  return {
    assistantMessage: { role: 'assistant', content: [] },
    alreadyPersisted: true,
    previewText: '',
    skipFinalize: true,
  };
}

/**
 * Resolve the Kiro API key: sender SSM > session initiator SSM > env var.
 * Mirrors the legacy loop's resolution order.
 */
async function resolveKiroApiKey(
  senderUserId: string | undefined,
  initiator: string | undefined
): Promise<string | undefined> {
  const apiKeyUserId = senderUserId || initiator;
  if (apiKeyUserId) {
    try {
      const key = await getKiroApiKey(apiKeyUserId);
      if (key) return key;
    } catch (e) {
      console.error('[kiro-acp-sdk-loop] Failed to retrieve Kiro API key from SSM:', e);
    }
  }
  return process.env.KIRO_API_KEY;
}

/**
 * Whether the current-turn MessageItem carries any renderable text/image/file
 * block. Parses the JSON `content` defensively (matches the legacy loop's
 * renderable gate without depending on its private `parseContentBlocks`).
 */
function hasRenderableBlocks(content: string): boolean {
  let blocks: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) blocks = parsed as Array<Record<string, unknown>>;
  } catch {
    return false;
  }
  return blocks.some((b) => {
    const text = b.text;
    if (typeof text === 'string' && text.trim().length > 0) return true;
    const image = b.image as { source?: { s3Key?: unknown } } | undefined;
    if (typeof image?.source?.s3Key === 'string') return true;
    const file = b.file as { source?: { s3Key?: unknown } } | undefined;
    if (typeof file?.source?.s3Key === 'string') return true;
    return false;
  });
}
