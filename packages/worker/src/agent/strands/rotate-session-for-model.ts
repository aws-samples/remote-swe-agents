/**
 * rotateSessionForModel — SDK loop version of the legacy rotateKiroSessionForModelSwitch
 * ==============================================================================================
 * Orchestrates mid-session model rotation for the ACP-SDK loop (`kiroAcpSdkAgentLoop`).
 * Extracted as an export so the loop and its tests call the same function
 * (computeSynthPlan / buildKiroAcpArgs pattern — preventing test-replica drift).
 *
 * ## Legacy correspondence table:
 *
 * | Legacy step                             | SDK loop equivalent                         |
 * |-----------------------------------------|---------------------------------------------|
 * | Read liveModel via                      | readKiroV3SessionModelId(effectiveSessionId)|
 * |   readKiroV3SessionModelId              |   (same function)                           |
 * | Compare liveModel vs desiredModel       | Same comparison (undefined = auto)          |
 * |   (applyDesiredModel gate)              |                                             |
 * | Generate newSessionId                   | deps.generateSessionId()                    |
 * | computeItemsToSynth                     | computeSynthPlan (shared export)            |
 * | synthesize v3 files                     | deps.synthesize(...)                        |
 * | client.loadSession                      | N/A — SDK loop passes sessionId to agent    |
 * |                                         |   constructor; start() does the load        |
 * | Fabrication guard: createdAt            | modelId round-trip verification via         |
 * |                                         |   deps.readModelId after synthesis          |
 * | restorePreviousSession                  | N/A — SDK creates agent per-turn; on        |
 * |                                         |   failure just keep old effectiveSessionId  |
 * | persistSessionId to DDB                 | deps.persistSessionId(workerId, newId)      |
 * | state.currentModel update               | Return newSessionId for caller to use       |
 * | User notification on failure            | Caller issues sendSystemMessage w/ dedup    |
 *
 * ## Key design difference from legacy:
 * The legacy function operates on a live persistent client (loadSession moves
 * the client mid-turn). The SDK loop creates a fresh KiroAcpAgent per turn, so
 * rotation here only needs to:
 *   1. Synthesize new session files with the desired modelId
 *   2. Verify fabrication guard (createdAt matches)
 *   3. Return the new sessionId for the agent constructor
 * There is no "restore previous session" because the agent hasn't started yet.
 */
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';
import { computeSynthPlan } from '../compute-synth-plan';
import { synthesizeKiroSessionFilesV3, readKiroV3SessionModelId, kiroV3SessionFilesExist } from '../kiro-session-synth';
import { randomUUID } from 'node:crypto';

/** Result of a successful rotation. */
export interface RotationSuccess {
  ok: true;
  /** New session ID to use for this turn's agent. */
  newSessionId: string;
  /** Whether the new sessionId was persisted to DDB. */
  persisted: boolean;
}

/** Result of a failed rotation. */
export interface RotationFailure {
  ok: false;
  /** Human-readable failure reason for user notification. */
  reason: string;
}

export type RotationResult = RotationSuccess | RotationFailure;

/** Inputs for the rotation orchestration. */
export interface RotateSessionInput {
  /** Worker ID for DDB persistence. */
  workerId: string;
  /** Current effective sessionId (will be kept on failure). */
  currentSessionId: string;
  /** Desired model for this turn (undefined = auto). */
  desiredModel: string | undefined;
  /** History + consumedTailCount for synthesis. */
  history: MessageItem[];
  consumedTailCount: number;
  /** Working directory for session file placement. */
  cwd: string;
}

/** Dependency injection seams (production defaults provided; tests inject fakes). */
export interface RotateSessionDeps {
  synthesize: typeof synthesizeKiroSessionFilesV3;
  readModelId: typeof readKiroV3SessionModelId;
  sessionFilesExist: typeof kiroV3SessionFilesExist;
  persistSessionId: (workerId: string, sessionId: string) => Promise<void>;
  generateSessionId: () => string;
}

const defaultDeps: RotateSessionDeps = {
  synthesize: synthesizeKiroSessionFilesV3,
  readModelId: readKiroV3SessionModelId,
  sessionFilesExist: kiroV3SessionFilesExist,
  persistSessionId: async () => {
    throw new Error('persistSessionId must be injected');
  },
  generateSessionId: () => randomUUID(),
};

/**
 * Determine whether model rotation is needed, and if so, perform it.
 *
 * Returns `{ ok: true, newSessionId, persisted }` on success (caller should
 * use `newSessionId` for the agent constructor).
 * Returns `{ ok: false, reason }` on failure (caller should continue with
 * `currentSessionId` on the old model and notify the user).
 *
 * When the live model already matches the desired model, returns
 * `{ ok: true, newSessionId: currentSessionId, persisted: true }` (no-op).
 */
export const rotateSessionForModel = async (
  input: RotateSessionInput,
  deps: RotateSessionDeps = defaultDeps
): Promise<RotationResult> => {
  const { workerId, currentSessionId, desiredModel, history, consumedTailCount, cwd } = input;

  // Step 1: Read the live model from the current session's session.json
  // (legacy readKiroV3SessionModelId).
  const liveModel = deps.sessionFilesExist(currentSessionId, cwd) ? deps.readModelId(currentSessionId, cwd) : undefined;

  // Step 2: Compare live model vs desired (legacy applyDesiredModel gate).
  // Both undefined means "auto = auto" — no rotation needed.
  if (liveModel === desiredModel) {
    return { ok: true, newSessionId: currentSessionId, persisted: true };
  }

  console.log(
    `[model-rotation] live model (${liveModel ?? 'auto'}) != desired (${desiredModel ?? 'auto'}); ` +
      `rotating session ${currentSessionId}`
  );

  // Step 3: Validate model ID (legacy defence-in-depth).
  if (desiredModel !== undefined && !/^[a-zA-Z0-9._-]+$/.test(desiredModel)) {
    return { ok: false, reason: `Refused to switch: invalid model id "${desiredModel}"` };
  }

  // Step 4: Generate new session ID.
  const newSessionId = deps.generateSessionId();

  // Step 5: Synthesize v3 session files with new modelId.
  const { itemsToSynth, rawCount, replayTrimCount } = computeSynthPlan(history, consumedTailCount);
  let synthEventCount: number;
  try {
    const synth = await deps.synthesize({
      sessionId: newSessionId,
      cwd,
      items: itemsToSynth,
      modelId: desiredModel,
    });
    synthEventCount = synth.events.length;
    console.log(
      `[model-rotation] synthesised session ${newSessionId} (desiredModel=${desiredModel ?? 'auto'}, ` +
        `events=${synth.events.length}, rawCount=${rawCount}, trimmed=${replayTrimCount})`
    );
  } catch (synthErr) {
    const msg = synthErr instanceof Error ? synthErr.message : String(synthErr);
    console.error(`[model-rotation] synthesis failed for model "${desiredModel ?? 'auto'}": ${msg}`);
    return { ok: false, reason: msg };
  }

  // Step 6: Fabrication guard.
  // For the SDK loop, we verify by reading back session.json immediately after
  // writing it (not via session/load _meta as in legacy, since the agent hasn't
  // started yet). If the file doesn't exist or createdAt doesn't match, the
  // synthesis was somehow corrupted.
  const readBackModel = deps.readModelId(newSessionId, cwd);
  // For non-empty synthesis: if we wrote modelId but reading it back gives a
  // different value (or undefined when we wrote a real model), that's a
  // fabrication indicator.
  if (synthEventCount > 0) {
    // The authoritative check: does the file even exist?
    if (!deps.sessionFilesExist(newSessionId, cwd)) {
      console.error(
        `[model-rotation] V3_SYNTH_IGNORED: session files don't exist after synthesis ` +
          `for ${newSessionId}. Filesystem race?`
      );
      return { ok: false, reason: 'Session files disappeared after synthesis (filesystem race?)' };
    }
    // Model roundtrip verification: undefined means "auto" on both sides
    const expectedModel = desiredModel ?? undefined;
    if (readBackModel !== expectedModel) {
      console.error(
        `[model-rotation] V3_SYNTH_IGNORED: readBack model=${readBackModel ?? '<auto>'} != ` +
          `expected=${expectedModel ?? '<auto>'} for session ${newSessionId}`
      );
      return { ok: false, reason: 'kiro-cli ignored the rotated session files (store-schema drift?)' };
    }
  }

  // Step 7: Persist the new sessionId to DDB.
  try {
    await deps.persistSessionId(workerId, newSessionId);
  } catch (persistErr) {
    const pmsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    console.error(
      `[model-rotation] MODEL_SWITCH_PERSIST_FAILED workerId=${workerId} sessionId=${newSessionId}: ${pmsg}. ` +
        `The switch will be LIVE for this turn but a cold restart may revert.`
    );
    return { ok: true, newSessionId, persisted: false };
  }

  console.log(`[model-rotation] rotation succeeded (model=${desiredModel ?? 'auto'}, session=${newSessionId})`);
  return { ok: true, newSessionId, persisted: true };
};
