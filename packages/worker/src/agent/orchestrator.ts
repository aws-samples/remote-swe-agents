import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getConversationHistory,
  repairDanglingToolUse,
  readMetadata,
  writeMetadata,
  readCommonPrompt,
  sendSystemMessage,
  getSession,
  getCustomAgent,
  saveConversationHistory,
  getLatestMessageSK,
  resolveToolEventSink,
  sendAgentMessage,
  isEndOfTurnPlaceholder,
  isScaffoldingArtifact,
  stripScaffoldingPrefix,
  isInterruptPlaceholder,
  isAckWordPlaceholder,
  listSkills,
  buildSkillCatalogue,
  downloadSkillFiles,
  deployKiroWorkspaceFiles,
  incrementUnread,
  sendPushNotificationToUser,
  notifyOtherParticipants,
  resolveNotificationAgentName,
  getPreferences,
  getUserPreferences,
  validateMermaidInText,
  buildMermaidFeedback,
  updateMessageType,
  toUserFacingTurnError,
  shouldSuppressUserDelivery,
  recordUserDelivery,
  shouldSuppressRehashOrSelfNarration,
  shouldSuppressWakeupMonologueDelivery,
  isNonUserTrigger,
  CONTEXT_USAGE_GUIDELINE_PERCENTAGE,
  buildContextUsageEnvironmentBlock,
  updateSession,
  applyRewindFilter,
} from '@remote-swe-agents/agent-core/lib';
import type {
  InferenceBackend,
  ModelFields,
  ModelOverrides,
  ToolEventSink,
  TurnContext,
  TurnResult,
} from '@remote-swe-agents/agent-core/lib';
import { resolveModelConfig } from '@remote-swe-agents/agent-core/lib';
import pRetry from 'p-retry';
import { CancellationToken } from '../common/cancellation-token';
import { notifyTermination } from '../common/notify-termination';
import { buildSessionHierarchyPrompt } from './lib/session-hierarchy';
import { DefaultAgent, getEssentialSystemPrompt, getDefaultKnowledgePrompt } from './lib/default-agent';
import { findRepositoryKnowledge } from './lib/knowledge';
import { refreshSession } from '../common/refresh-session';
import { getProcessRuntimeType } from '../runtime-type';
import { dumpHandoverHistory, getHandoverLogPath } from './lib/handover-history';
import { persistErrorBubble } from './persist-error-bubble';

// Re-export the shared placeholder / scaffolding detectors so existing
// unit tests that import them from `./orchestrator` keep working. The
// actual implementations live in @remote-swe-agents/agent-core so the
// `sendMessageToUser` tool (which lives in agent-core) can reuse them
// — both delivery paths MUST apply the same filter, otherwise the
// regression reopens on whichever path is out of sync.
export { isEndOfTurnPlaceholder, isScaffoldingArtifact, stripScaffoldingPrefix, isInterruptPlaceholder };

/**
 * Fetch conversation history with a retry to guard against DynamoDB replication
 * lag — the last item must be a user/event/agent message, not an assistant
 * message (that would indicate a stale read of the previous turn).
 */
const fetchHistoryWithReplicationRetry = async (workerId: string) => {
  return pRetry(
    async (attemptCount) => {
      const res = await getConversationHistory(workerId);
      const lastItem = res.items.at(-1);
      if (
        lastItem == null ||
        lastItem.messageType === 'userMessage' ||
        lastItem.messageType === 'eventTrigger' ||
        lastItem.messageType === 'agentMessage' ||
        lastItem.messageType === 'systemRetrigger' ||
        lastItem.messageType === 'mermaidFeedback' ||
        attemptCount > 4
      ) {
        return res;
      }
      throw new Error('Last message is from assistant. Possibly DynamoDB replication delay.');
    },
    { retries: 5, minTimeout: 100, maxTimeout: 1000 }
  );
};

/**
 * Build a "Runtime Environment" section that tells the agent its own effective
 * runtime type, inference provider, and model. Uses the process-level ground
 * truth for runtime type (set at entry point) and the same resolution chain
 * as the actual inference path for model (overrides > session > customAgent >
 * userPreferences > env > default).
 */
export const buildRuntimeEnvironmentBlock = (opts: {
  session: import('@remote-swe-agents/agent-core/schema').SessionItem | undefined;
  customAgent: import('@remote-swe-agents/agent-core/schema').CustomAgent;
  overrides?: import('@remote-swe-agents/agent-core/lib').ModelOverrides;
  userPreferences?: import('@remote-swe-agents/agent-core/lib').ModelFields;
}): string => {
  const { session, customAgent, overrides, userPreferences } = opts;

  const runtimeType = getProcessRuntimeType();

  const resolved = resolveModelConfig({
    overrides,
    session: session
      ? {
          inferenceMode: session.inferenceMode,
          bedrockDefaultModel: session.bedrockDefaultModel,
          kiroDefaultModel: session.kiroDefaultModel,
          kiroModel: session.kiroModel,
        }
      : undefined,
    customAgent: {
      inferenceMode: customAgent.inferenceMode,
      bedrockDefaultModel: customAgent.bedrockDefaultModel,
      defaultModel: customAgent.defaultModel,
      kiroDefaultModel: customAgent.kiroDefaultModel,
      kiroModel: customAgent.kiroModel,
    },
    userPreferences,
    env: { inferenceMode: process.env.INFERENCE_MODE },
  });

  const lines: string[] = ['## Runtime Environment'];
  if (runtimeType) {
    lines.push(`- Runtime type: ${runtimeType}`);
  }
  lines.push(`- Inference provider: ${resolved.inferenceMode}`);
  if (resolved.inferenceMode === 'kiro-cli') {
    const modelDisplay = resolved.kiroModel === 'auto' ? 'auto (dynamically selected)' : resolved.kiroModel;
    lines.push(`- Model: ${modelDisplay}`);
  } else {
    lines.push(`- Model: ${resolved.bedrockModel}`);
  }

  return lines.join('\n');
};

/**
 * Compose the layered system prompt in the same order as the original agent
 * loops: essential → knowledge → custom → common → repo knowledge → session
 * hierarchy. Kept in a single place so backends don't re-implement it.
 */
const buildSystemPrompt = async (opts: {
  workerId: string;
  customAgent: import('@remote-swe-agents/agent-core/schema').CustomAgent;
  session: import('@remote-swe-agents/agent-core/schema').SessionItem | undefined;
  history: import('@remote-swe-agents/agent-core/schema').MessageItem[];
  senderUserId: string | undefined;
}): Promise<{
  systemPrompt: string;
  cwd: string;
  userSkills: import('@remote-swe-agents/agent-core/schema').Skill[];
  kiroAgentName?: string;
}> => {
  const { workerId, customAgent, session, history, senderUserId } = opts;
  const runtimeType = getProcessRuntimeType();
  const essentialPrompt = getEssentialSystemPrompt(runtimeType);
  const hasCustomPrompt = Boolean(customAgent.systemPrompt);
  const includeKnowledge = !hasCustomPrompt || customAgent.includeDefaultKnowledge !== false;
  const knowledgePrompt = includeKnowledge ? getDefaultKnowledgePrompt() : '';
  const customPrompt = hasCustomPrompt ? customAgent.systemPrompt : '';
  let systemPrompt = [essentialPrompt, knowledgePrompt, customPrompt].filter(Boolean).join('\n\n');

  try {
    const commonPromptData = await readCommonPrompt();
    if (commonPromptData?.additionalSystemPrompt) {
      systemPrompt = `${systemPrompt}\n\n## Common Prompt\n${commonPromptData.additionalSystemPrompt}`;
    }
  } catch (error) {
    console.error('[orchestrator] Error retrieving common prompt:', error);
  }

  // Progressive disclosure: inject skill catalogue (name + description only)
  // and download skill files to /tmp/skills/{skillId}/ for Read tool access
  let userSkills: import('@remote-swe-agents/agent-core/schema').Skill[] = [];
  if (session?.initiator) {
    try {
      const userId = session.initiator.includes('#') ? session.initiator.split('#').pop()! : session.initiator;
      userSkills = await listSkills(userId);
      if (userSkills.length > 0) {
        const catalogue = buildSkillCatalogue(userSkills);
        if (catalogue) {
          systemPrompt = `${systemPrompt}\n\n${catalogue}`;
        }
        await downloadSkillFiles(userSkills);
      }
    } catch (error) {
      console.error('[orchestrator] Error loading skills:', error);
    }
  }

  const defaultCwd = join(homedir(), '.remote-swe-workspace');
  mkdirSync(defaultCwd, { recursive: true });
  let cwd = defaultCwd;
  try {
    const repo = await readMetadata('repo', workerId);
    if (repo?.repoDirectory) {
      const repoDir = repo.repoDirectory as string;
      if (existsSync(repoDir)) {
        cwd = repoDir;
        const { content: knowledgeContent, found } = findRepositoryKnowledge(cwd);
        if (found) {
          systemPrompt = `${systemPrompt}\n## Repository Knowledge\n${knowledgeContent}`;
        }
      } else {
        console.warn(
          `[orchestrator] repoDirectory "${repoDir}" does not exist (compute hopping?). Falling back to "${defaultCwd}" and clearing stale metadata.`
        );
        await writeMetadata('repo', { repoOrg: repo.repoOrg, repoName: repo.repoName, isFork: repo.isFork }, workerId);
      }
    }
  } catch (error) {
    console.error('[orchestrator] Error retrieving repository metadata:', error);
  }

  // Resolve inference mode once for both deploy gating and runtime env block.
  const inferenceMode = resolveModelConfig({
    session: session ? { inferenceMode: session.inferenceMode } : undefined,
    customAgent: { inferenceMode: customAgent.inferenceMode },
    env: { inferenceMode: process.env.INFERENCE_MODE },
  }).inferenceMode;

  // Deploy kiro-native workspace files (hooks, agents, tools) from skills to a
  // directory OUTSIDE the repo so kiro-cli can discover them via symlink. Only
  // deploy when the session runs in kiro-cli inference mode — the hooks
  // mechanism is a kiro-cli-native feature with no effect on Bedrock sessions.
  let kiroAgentName: string | undefined;
  if (userSkills.length > 0 && inferenceMode === 'kiro-cli') {
    try {
      kiroAgentName = deployKiroWorkspaceFiles(userSkills, cwd, workerId);
    } catch (error) {
      // Deploy failed — kiroAgentName stays undefined so the kiro agent loop
      // will NOT pass --agent, preventing a launch against a missing agent JSON.
      console.error('[orchestrator] kiro workspace deployment failed:', error);
    }
  }

  const runtimeEnvBlock = await (async () => {
    const lastUserMsg = history.filter((i) => i.role === 'user').at(-1);

    let overrides: ModelOverrides | undefined;
    let userPrefs: ModelFields | undefined;

    if (inferenceMode === 'kiro-cli') {
      const perMessageModel = lastUserMsg?.kiroModelOverride;
      if (perMessageModel) overrides = { kiroModelOverride: perMessageModel };
      if (senderUserId) {
        try {
          const prefs = await getUserPreferences(senderUserId);
          userPrefs = { kiroDefaultModel: prefs.kiroDefaultModel, kiroModel: prefs.kiroModel };
        } catch {
          /* best-effort */
        }
      }
    } else {
      // Only the triggering (last user) message's per-message override takes
      // highest priority. User preferences go through the proper userPreferences
      // channel so they never shadow session.bedrockDefaultModel.
      const perMessageModel = lastUserMsg?.modelOverride;
      if (perMessageModel) overrides = { modelOverride: perMessageModel };
      try {
        const globalPrefs = await getPreferences();
        if (globalPrefs.modelOverride) {
          userPrefs = {
            bedrockDefaultModel: globalPrefs.modelOverride as import('@remote-swe-agents/agent-core/schema').ModelType,
          };
        }
      } catch {
        /* best-effort */
      }
    }

    return buildRuntimeEnvironmentBlock({ session, customAgent, overrides, userPreferences: userPrefs });
  })();
  systemPrompt = `${systemPrompt}\n\n${runtimeEnvBlock}`;

  if (session) {
    const handoverSourceId = session.handoverSourceSessionId;
    if (handoverSourceId) {
      const handoverLogPath = getHandoverLogPath(handoverSourceId);
      if (existsSync(handoverLogPath)) {
        systemPrompt = `${systemPrompt}\n\n## Predecessor Session Context\nThe full conversation history from the predecessor session (${handoverSourceId}) is available at:\n\`${handoverLogPath}\`\nUse the read_file tool to access it when you need additional context beyond what is provided in this session's seed message.`;
      }
    }
  }

  if (session?.title) {
    const sanitizedTitle = session.title
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 100);
    if (sanitizedTitle) {
      systemPrompt = `${systemPrompt}\n\n## Session Context\nSession title: "${sanitizedTitle}"\nThis session's primary purpose is described by its title. Always act consistently with it. When the user raises issues or asks questions, first consider how they relate to this session's purpose and review child sessions (if any) before responding.`;
    }
  }

  if (session) {
    const hierarchyPrompt = await buildSessionHierarchyPrompt(workerId, session);
    if (hierarchyPrompt) {
      systemPrompt = `${systemPrompt}${hierarchyPrompt}`;
    }
  }

  return { systemPrompt, cwd, userSkills, kiroAgentName };
};

/**
 * Trim-and-classify helper for the placeholder detector. Narrow on purpose:
 * real short replies like "ok" / "done" / "4" must still reach the user
 * because the new Kiro prompt invites the model to write a concise
 * completion summary as end-of-turn text.
 *
 * The implementation lives in `@remote-swe-agents/agent-core/lib` so the
 * `sendMessageToUser` tool can apply the same filter on its delivery
 * path; see `lib/placeholder-detection.ts` there.
 */

/**
 * Decide whether the user-facing finalisation (Slack send, last-message
 * preview update, parent redirect) should be suppressed for a turn whose
 * end-of-turn text is a placeholder or a scaffolding artifact.
 *
 * Kept intentionally thin: we only look at the end-of-turn text. An earlier
 * iteration also tried to correlate against the final tool_use in the turn
 * ("if the last tool was sendMessageToUser, suppress"), but `ctx.history`
 * is the snapshot captured at turn start — the turn\'s own tool_use and
 * tool_result items are persisted inside the backend and never re-fetched
 * before `finalizeTurn` runs. That made the tool-scan branch effectively
 * dead code in production. We removed it rather than ship code that
 * pretends to do more than it can.
 *
 * Suppression fires when EITHER:
 *  1. The prefix-stripped remainder is a placeholder
 *  (empty / "." / whitespace / single punctuation).
 *  2. The whole message is a scaffolding artifact (single `<...>` block).
 *
 * Branch 1 already covers whole-message artifacts (which strip to empty),
 * but branch 2 is kept as an explicit check for readability and defense
 * in depth.
 *
 * The assistant message itself is always persisted before this check; we
 * only gate the user-facing side effects.
 *
 * Exported for unit testing.
 */
export const shouldSuppressFinalize = (previewText: string): boolean => {
  const sanitised = stripScaffoldingPrefix(previewText);
  return (
    isEndOfTurnPlaceholder(sanitised) ||
    isScaffoldingArtifact(previewText) ||
    isInterruptPlaceholder(previewText) ||
    isAckWordPlaceholder(previewText)
  );
};

/**
 * Extract the user-visible text from the last history item. Used by backends
 * (primarily Kiro) that need the raw prompt text as a string.
 */
const extractUserMessage = (lastItem: import('@remote-swe-agents/agent-core/schema').MessageItem): string => {
  if (lastItem.role !== 'user' || !lastItem.content) return '';
  try {
    const parsed = JSON.parse(lastItem.content) as Array<{ text?: string }>;
    return parsed
      .filter((c): c is { text: string } => c.text !== undefined)
      .map((c) => c.text)
      .join('\n');
  } catch {
    return lastItem.content;
  }
};

/** Build the shared per-turn context. Returns undefined if the turn should be skipped. */
export const buildTurnContext = async (
  workerId: string,
  cancellationToken: CancellationToken,
  senderUserId: string | undefined
): Promise<TurnContext | undefined> => {
  const session = await getSession(workerId);
  const customAgent = (await getCustomAgent(session?.customAgentId)) ?? DefaultAgent;

  if (session?.handoverSourceSessionId) {
    try {
      await dumpHandoverHistory(session);
    } catch (e) {
      console.error('[orchestrator] Error dumping handover history:', e);
    }
  }

  const { items: allItems, slackUserId } = await fetchHistoryWithReplicationRetry(workerId);
  if (!allItems) return undefined;

  // Repair any dangling toolUse items from a prior interrupted turn. Runs for
  // every backend because both Bedrock and Kiro now persist per-tool items.
  const repairedItems = await repairDanglingToolUse(workerId, allItems);
  if (repairedItems.length > 0) {
    for (const repairedItem of repairedItems) {
      const insertIndex = allItems.findIndex((item) => item.SK > repairedItem.SK);
      if (insertIndex === -1) {
        allItems.push(repairedItem);
      } else {
        allItems.splice(insertIndex, 0, repairedItem);
      }
    }
  }

  // Non-destructive rewind: hide messages between cutoffSK and rewindedAt so
  // the model only sees the history up to the rewind point plus any new
  // messages written after the rewind. The filter is a pure in-memory pass
  // (no DDB writes), applied identically here and in the kiro session synth.
  const filteredItems = applyRewindFilter(allItems, session?.rewindState);

  const lastItem = filteredItems.at(-1);
  if (!lastItem) return undefined;

  const userMessage = extractUserMessage(lastItem);
  const { systemPrompt, cwd, userSkills, kiroAgentName } = await buildSystemPrompt({
    workerId,
    customAgent,
    session,
    history: filteredItems,
    senderUserId,
  });

  await refreshSession(workerId);

  // Design B: dynamic environment block telling the model its own context-window
  // usage (from the previous turn's measurement, persisted on the session).
  // Built fresh each turn and injected into the system layer by the backend —
  // never written to history — so it shows the model current state without
  // accumulating context.
  const environmentBlock = buildContextUsageEnvironmentBlock(session?.lastContextUsagePercentage);

  return {
    workerId,
    session,
    customAgent,
    history: filteredItems,
    systemPrompt,
    cwd,
    userMessage,
    slackUserId,
    senderUserId,
    cancellationToken,
    userSkills,
    environmentBlock,
    kiroAgentName,
  };
};

/** Finalize a successful turn: persist final message (if backend didn't), Slack, last-message, parent redirect. */
export const finalizeTurn = async (ctx: TurnContext, result: TurnResult): Promise<void> => {
  if (result.skipFinalize) return;

  let messageSK = result.messageSK;
  if (!result.alreadyPersisted) {
    // ordering guard: clamp the final assistant SK after every intra-turn
    // message so it never sorts before a `sendMessageToAgent` /
    // `sendMessageToUser` emitted earlier this turn. (Kiro persists its own
    // final message with the same guard; this covers backends that defer
    // persistence to the orchestrator, e.g. Bedrock.)
    const latestSK = await getLatestMessageSK(ctx.workerId);
    const savedItem = await saveConversationHistory(ctx.workerId, result.assistantMessage, 0, 'assistant', undefined, {
      ensureAfterSK: latestSK,
    });
    messageSK = savedItem.SK;
  }

  // Narrow guard against obviously-unusable placeholder end-of-turn text
  // (empty / whitespace / "." / single punctuation / pure scaffolding
  // artifact like "<continued in the following tool call>"). When the model
  // produces such a placeholder we skip Slack / last-message preview /
  // parent redirect — there is nothing worth delivering. The assistant
  // message is already persisted above, which keeps history coherent for
  // subsequent turns. See shouldSuppressFinalize for the reasoning.
  if (shouldSuppressFinalize(result.previewText)) {
    return;
  }

  // Strip a leading scaffolding `<...>` decorator from the preview text
  // so the user never sees it, but deliver the legitimate remainder
  // through every downstream channel (last-message preview, webapp
  // event, parent redirect, Slack). `stripScaffoldingPrefix` is a no-op
  // for texts that do not match the narrow keyword-gated pattern.
  const deliveredText = stripScaffoldingPrefix(result.previewText);

  // Duplicate suppression for the end-of-turn user-facing delivery. Same
  // root cause as the report-progress tool path: an inference-stage failure
  // (-32603 / prompt timeout) after this text was already delivered triggers
  // an auto-retrigger that re-runs the turn and re-emits (almost) the same
  // closing text. Suppress the user-facing side (last-message preview, Slack /
  // webapp message, unread + push) when it near-duplicates a recent delivery.
  //
  // The parent-redirect below is intentionally NOT gated by THIS flag: it is
  // the agent-to-agent path (different recipient) and already has its own
  // dedup in `sendAgentMessage`. (It IS gated by the separate
  // `suppressSelfNarration` flag added below — see that block for why.)
  //
  // Best-effort and biased toward DELIVERING — the lookup swallows its own
  // errors so a dedup-bookkeeping problem can never drop a genuine message.
  // The extra try/catch here is defense-in-depth at the orchestrator boundary:
  // even if a future change to shouldSuppressUserDelivery were to throw, the
  // turn's end-of-turn delivery must still go out (fail-open).
  let suppressUserDelivery = false;
  if (!result.abnormalTermination) {
    try {
      suppressUserDelivery = await shouldSuppressUserDelivery(ctx.workerId, deliveredText);
    } catch (e) {
      console.error('[orchestrator] user-delivery dedup check failed; delivering anyway:', e);
    }
  }
  if (suppressUserDelivery) {
    console.warn(
      `[orchestrator] Suppressing near-duplicate end-of-turn user delivery for ${ctx.workerId} ` +
        `(likely auto-retrigger re-emit; first 80 chars="${deliveredText.slice(0, 80).replace(/\s+/g, ' ')}")`
    );
  }

  // Deterministic self-narration / cross-turn rehash / no-information wake-up
  // monologue suppression ( / / ). These are the prompt-independent
  // backstop for the recurring "duplicate / internal-monologue leaked to the
  // user" symptom that the prompt guidance alone could not fix. Applied at this
  // single end-of-turn choke-point so EVERY agent benefits automatically with
  // no per-agent prompt work.
  //
  //  the closing text echoes (verbatim, near-dup, or paraphrased
  //  summary) something this session already delivered/sent within
  //  the dedup window — including this turn's own send-tool calls.
  //  a non-user-triggered wake-up turn that ran NO new work tool
  //  whose text is internal monologue / meta scaffolding.
  //
  // Tracked in a SEPARATE flag (`suppressSelfNarration`) from the original
  // auto-retrigger near-dup flag so the parent-redirect gating below can
  // distinguish the two: the original near-dup path intentionally still
  // redirects (sendAgentMessage dedups it), whereas noise must NOT be
  // relayed to the parent (sendAgentMessage's near-dup dedup does not catch
  // self-narration / monologue).
  //
  // Both are fail-open (their own try/catch returns false on error) and biased
  // toward DELIVERING, consistent with the rest of the dedup family. They only
  // run when the message would otherwise be delivered, so they never resurrect
  // an already-suppressed message.
  let suppressSelfNarration = false;
  if (!suppressUserDelivery && !result.abnormalTermination) {
    const lastIncomingForGate = ctx.history.filter((i) => i.role === 'user').at(-1);
    const turnStartSK = ctx.history.at(-1)?.SK;
    try {
      if (await shouldSuppressRehashOrSelfNarration(ctx.workerId, deliveredText)) {
        suppressSelfNarration = true;
        console.warn(
          `[orchestrator] Suppressing rehash / self-narration end-of-turn delivery for ${ctx.workerId} ` +
            `(echoes a recent delivery/send; first 80 chars="${deliveredText.slice(0, 80).replace(/\s+/g, ' ')}")`
        );
      } else if (
        await shouldSuppressWakeupMonologueDelivery(ctx.workerId, deliveredText, {
          triggerMessageType: lastIncomingForGate?.messageType,
          turnStartSK,
        })
      ) {
        suppressSelfNarration = true;
        console.warn(
          `[orchestrator] Suppressing no-information wake-up monologue for ${ctx.workerId} ` +
            `(non-user trigger + zero new work tool + monologue pattern; first 80 chars="${deliveredText
              .slice(0, 80)
              .replace(/\s+/g, ' ')}")`
        );
      } else if (isNonUserTrigger(lastIncomingForGate?.messageType) && isAckWordPlaceholder(deliveredText)) {
        suppressSelfNarration = true;
        console.warn(
          `[orchestrator] Suppressing ack-word placeholder for ${ctx.workerId} ` +
            `(non-user trigger + ack word only; text="${deliveredText.trim()}")`
        );
      }
    } catch (e) {
      console.error('[orchestrator] self-narration filter failed; delivering anyway:', e);
    }
  }
  // From here on the user-facing side is gated by EITHER suppression reason.
  suppressUserDelivery = suppressUserDelivery || suppressSelfNarration;

  const mention = ctx.slackUserId ? `<@${ctx.slackUserId}> ` : '';
  // lastMessageUpdate + DDB session.lastMessage update is now handled inside
  // sendSystemMessage (single-source), so no separate emit needed here.

  if (ctx.session?.parentSessionId && !result.abnormalTermination) {
    const lastIncoming = ctx.history.filter((i) => i.role === 'user').at(-1);
    // The parent redirect is the agent-to-agent path (separate recipient, with
    // its own near-dup dedup in `sendAgentMessage`), so the ORIGINAL
    // auto-retrigger near-dup suppression (`shouldSuppressUserDelivery`) does
    // NOT gate it — `sendAgentMessage` folds that re-emit on its own.
    //
    // It IS gated by `suppressSelfNarration` ( self-narration / wake-up
    // monologue), because that noise is just as unwanted on the child→parent
    // path and `sendAgentMessage`'s near-dup dedup does not catch it (
    // are not necessarily near-duplicates of a previous agent message — they
    // are narration / monologue with no prior peer message to match).
    if (lastIncoming?.messageType === 'agentMessage' && !lastIncoming.isAcknowledge && !suppressSelfNarration) {
      try {
        await sendAgentMessage({
          senderWorkerId: ctx.workerId,
          targetSessionIds: [ctx.session.parentSessionId],
          message: deliveredText,
        });
      } catch (e) {
        console.error('[orchestrator] Failed to redirect end-of-turn to parent:', e);
      }
    }
  }

  if (!suppressUserDelivery) {
    await sendSystemMessage(
      ctx.workerId,
      `${mention}${deliveredText}`,
      true,
      // Skip the webapp message emit when the backend has already
      // delivered the same text through its own channel (currently:
      // Kiro's tool-boundary text flush in `kiroAgentLoop`). Avoids
      // duplicate assistant bubbles in the webapp; Slack / sidebar /
      // parent / push are still delivered above and below.
      result.webappMessageAlreadyEmitted ?? false,
      messageSK
    );

    // Record the delivery so a subsequent auto-retrigger re-emit can be
    // suppressed. Best-effort: a persist failure must never break delivery.
    await recordUserDelivery(ctx.workerId, deliveredText);
  }

  // Increment unread count + push notification for end-of-turn text delivery.
  //
  // Hard guard: only fire when the trigger of THIS turn was a real user
  // message (`messageType === 'userMessage'`). Any other trigger
  // (`agentMessage` from a child / sibling, `eventTrigger`, etc.) is treated
  // as agent-internal traffic and must NOT bump the user's unread/push
  // channel.
  //
  // This subsumes the previous "isRedirectedToParent" check (which only
  // covered child sessions whose turn was triggered by a parent agentMessage)
  // and additionally fixes the regression where a TOP-LEVEL session, on
  // receiving a `[Child error]` / `[Child sleeping]` agentMessage from one of
  // its children, would emit a user-facing badge bump + push for its own
  // wake-up response. The redirect flag was hardcoded to false for top-level
  // sessions because the inner `if (parentSessionId)` block was skipped, so
  // the push fired every time an agentMessage triggered a top-level turn.
  //
  // eventTrigger callers also fall into the "not a user message" bucket and
  // are intentionally skipped here. This matches the current end-of-turn
  // behaviour (no spec change) — when an event fires and the agent runs a
  // turn, the user did not initiate it, so a push is not warranted.
  try {
    if (!suppressUserDelivery) {
      const lastIncoming = ctx.history.filter((i) => i.role === 'user').at(-1);
      if (lastIncoming?.messageType === 'userMessage') {
        const prefs = await getPreferences();
        const agentDisplayName = resolveNotificationAgentName({
          customAgentId: ctx.session?.customAgentId,
          customAgentName: ctx.customAgent?.name,
          sessionAgentName: ctx.session?.agentName,
          defaultAgentName: prefs.defaultAgentName || undefined,
        });
        const sessionLabel = (ctx.session?.title || ctx.workerId).slice(0, 80);
        const title = agentDisplayName;
        const body = `${sessionLabel}\n${deliveredText.slice(0, 200)}`;

        if (ctx.session?.initiator?.startsWith('webapp#')) {
          const userId = ctx.session.initiator.replace('webapp#', '');
          await incrementUnread(userId, ctx.workerId);
          await sendPushNotificationToUser(userId, {
            title,
            body,
            url: `/sessions/${ctx.workerId}`,
            workerId: ctx.workerId,
          });
          // Notify other participants, excluding initiator to avoid double-notification
          await notifyOtherParticipants(ctx.workerId, userId, { title, body });
        } else {
          // Non-webapp initiator (e.g. Slack): still notify all webapp participants
          await notifyOtherParticipants(ctx.workerId, undefined, { title, body });
        }
      }
    }
  } catch (e) {
    console.error('[orchestrator] Failed to increment unread on finalize:', e);
  }
};

/** Centralised error handling when a backend's runTurn throws unexpectedly. */
export const handleTurnError = async (
  workerId: string,
  slackUserId: string | undefined,
  error: unknown
): Promise<void> => {
  const message = error instanceof Error ? error.message : String(error);
  // Always log the RAW error to CloudWatch for internal observability.
  console.error(`[orchestrator] Turn failed: ${message}`);
  // ...but never leak a recognised Kiro infrastructure error (wedged
  // subprocess / idle / wall-clock watchdog / -32603 "Internal error" /
  // "Kiro failed to generate a response" / "process died") verbatim to the
  // UX. Collapse it to the canonical phrase; genuinely actionable errors
  // pass through unchanged.
  const userFacing = toUserFacingTurnError(message);
  const errorText = slackUserId
    ? `<@${slackUserId}> An error occurred: ${userFacing}`
    : `An error occurred: ${userFacing}`;

  const messageSK = await persistErrorBubble(workerId, errorText);
  await sendSystemMessage(workerId, errorText, true, false, messageSK);

  try {
    await notifyTermination(workerId, 'error', userFacing);
  } catch (e) {
    console.error('[orchestrator] Failed to notify owner of error:', e);
  }
};

/** Maximum number of mermaid validation retries before passing through. */
const MAX_MERMAID_RETRIES = 2;

/** Top-level orchestrator entry point — runs one full turn against the given backend. */
export const runTurnWithBackend = async (
  workerId: string,
  cancellationToken: CancellationToken,
  backend: InferenceBackend,
  senderUserId?: string,
  sink: ToolEventSink = resolveToolEventSink()
): Promise<void> => {
  let ctx: TurnContext | undefined;
  try {
    ctx = await buildTurnContext(workerId, cancellationToken, senderUserId);
    if (!ctx) return;
    let result = await backend.runTurn(ctx, sink);
    if (cancellationToken.isCancelled) return;

    // Mermaid self-heal: validate diagrams before delivering to user.
    // If broken, reject the message and retry up to MAX_MERMAID_RETRIES times.
    let mermaidRetries = 0;
    while (!result.skipFinalize && result.previewText && mermaidRetries < MAX_MERMAID_RETRIES) {
      if (cancellationToken.isCancelled) break;
      const fullText = (result.assistantMessage.content ?? [])
        .filter((b): b is { text: string } => 'text' in b && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      const validation = await validateMermaidInText(fullText || result.previewText);
      if (validation.valid) break;

      console.log(
        `[orchestrator] Mermaid validation failed (attempt ${mermaidRetries + 1}/${MAX_MERMAID_RETRIES}): ${validation.errors.length} error(s)`
      );

      // Mark the already-persisted assistant message as rejected so it
      // won't render in the webapp on reload.
      const lastAssistant = ctx.history
        .concat(
          // The message was just persisted by the backend but may not be in
          // ctx.history (which is a snapshot from turn start). Find it by
          // re-fetching the latest item.
          []
        )
        .filter((i) => i.messageType === 'assistant')
        .at(-1);
      // Re-fetch to get the SK of the just-persisted message
      const { items: freshItems } = await getConversationHistory(workerId);
      const lastPersistedAssistant = freshItems.filter((i) => i.messageType === 'assistant').at(-1);
      if (lastPersistedAssistant) {
        await updateMessageType(workerId, lastPersistedAssistant.SK, 'assistantRejected');
      }

      // Inject feedback as a user message so the LLM sees the error on retry
      const feedback = buildMermaidFeedback(validation.errors);
      const feedbackMessage: import('@aws-sdk/client-bedrock-runtime').Message = {
        role: 'user',
        content: [{ text: feedback }],
      };
      await saveConversationHistory(workerId, feedbackMessage, 0, 'mermaidFeedback');

      mermaidRetries++;

      // Rebuild context and re-run the backend
      ctx = await buildTurnContext(workerId, cancellationToken, senderUserId);
      if (!ctx || cancellationToken.isCancelled) return;
      result = await backend.runTurn(ctx, sink);
      if (cancellationToken.isCancelled) return;
    }

    await finalizeTurn(ctx, result);

    // Observability: emit ONE line per turn with the normalised context-window
    // utilisation, for BOTH backends, whenever the value is known. This is the
    // canonical signal for "how full is this session's context right now" — it
    // makes the Kiro path observable in production (kiro-cli's own
    // `_kiro.dev/metadata` percentage, which would otherwise only surface in a
    // handover log) and gives Bedrock the same turn-level visibility. Kept to
    // workerId + backend + percentage only (no conversation content / secrets)
    // and gated on a known value so it never adds noise on turns without usage.
    if (result.contextUsagePercentage !== undefined) {
      console.log(
        `[context-usage] workerId=${workerId} backend=${backend.kind} ` +
          `contextUsagePercentage=${result.contextUsagePercentage.toFixed(2)} ` +
          `threshold=${CONTEXT_USAGE_GUIDELINE_PERCENTAGE}`
      );
      // Persist for the NEXT turn's environment block (design B). Best-effort:
      // a write failure must never break the turn.
      try {
        await updateSession(workerId, { lastContextUsagePercentage: result.contextUsagePercentage });
      } catch (e) {
        console.error('[orchestrator] failed to persist lastContextUsagePercentage; continuing:', e);
      }
    }

    // Single parent-notify choke-point for abnormal turn ends (e.g. the Kiro
    // backend gave up after a prompt failure and returned instead of throwing).
    // finalizeTurn's parent redirect only fires for agentMessage-triggered
    // turns, so a failure on an eventTrigger / systemRetrigger turn would
    // otherwise leave the parent waiting forever. notifyTermination wakes the
    // parent with a `[Child error]` and is a no-op for top-level sessions.
    if (result.abnormalTermination && ctx.session?.parentSessionId) {
      await notifyTermination(workerId, 'error', result.abnormalTermination.reason);
    }

    // Auto-retrigger: if the backend signalled a delayed retry, sleep then
    // save a synthetic user message and recurse. The recursion is bounded by
    // the backend's own time-based retrigger budget (see
    // computeRetriggerBackoffMs / getRetriggerBurstStats in kiro-agent-loop).
    if (result.retrigger && !cancellationToken.isCancelled) {
      const delayMs = result.retriggerDelayMs ?? 30_000;
      console.log(`[orchestrator] Sleeping ${delayMs}ms before auto-retrigger`);
      await new Promise<void>((r) => setTimeout(r, delayMs));
      if (cancellationToken.isCancelled) return;
      const retriggerMessage: import('@aws-sdk/client-bedrock-runtime').Message = {
        role: 'user',
        content: [
          {
            text: `[System] Auto-retrigger after prompt timeout
<command>
This is an automatic retry after a temporary internal failure. Your previous attempt on this turn may have already sent a reply (Send Message To Agent / Acknowledge Agent / Send Message To User). Do NOT re-send the same or similar message. Only produce output if you have genuinely new work to perform. If you have nothing new to add, end your turn silently with no text output.
</command>`,
          },
        ],
      };
      await saveConversationHistory(workerId, retriggerMessage, 0, 'systemRetrigger');
      await runTurnWithBackend(workerId, cancellationToken, backend, senderUserId, sink);
    }
  } catch (error) {
    // Best-effort: use ctx.slackUserId if we already built the context.
    await handleTurnError(workerId, ctx?.slackUserId, error);
  }
};
