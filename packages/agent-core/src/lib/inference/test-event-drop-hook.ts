import { ToolEventSink, ToolUseEmit } from './types';
import { defaultToolEventSink } from './default-sink';

/**
 * Environment variable that enables the test event drop hook.
 * The name contains "TEST" explicitly to prevent accidental production use.
 * Must be set to the string "true" to activate.
 */
const TEST_ENV_VAR = 'REMOTE_SWE_TEST_EVENT_DROP_ENABLED';

/**
 * Tool names whose emitToolUseEvent renders as a message bubble in the webapp
 * AND whose drop triggers the lastMessageUpdate self-recovery path.
 *
 * Only sendMessageToUser variants qualify — sendImageToUser / sendFileToUser
 * render differently and are NOT covered by `isPreviewRendered` recovery.
 * E2E tests MUST use sendMessageToUser to trigger the drop scenario.
 *
 * Source of truth: packages/webapp/src/app/sessions/[workerId]/component/
 * SessionPageClient `isMsg()` check + message-consistency.ts
 * `isPreviewRendered` (which only matches message-type bubbles).
 */
const MESSAGE_RENDERING_TOOLS = new Set([
  'sendMessageToUser',
  'sendMessageToUserIfNecessary',
  'Send Message To User',
  'Send_Message_To_User',
]);

let hasDroppedEvent = false;
let warningLogged = false;

const wrappedSink: ToolEventSink = {
  persistToolUseMessage: defaultToolEventSink.persistToolUseMessage.bind(defaultToolEventSink),
  persistToolResultMessage: defaultToolEventSink.persistToolResultMessage.bind(defaultToolEventSink),

  async emitToolUseEvent(workerId: string, payload: ToolUseEmit): Promise<void> {
    if (!hasDroppedEvent && MESSAGE_RENDERING_TOOLS.has(payload.toolName)) {
      hasDroppedEvent = true;
      console.warn(
        `[TEST-EVENT-DROP-HOOK] DROPPED toolUse event | workerId=${workerId} toolName=${payload.toolName} toolUseId=${payload.toolUseId}`
      );
      return;
    }
    return defaultToolEventSink.emitToolUseEvent(workerId, payload);
  },

  emitToolResultEvent: defaultToolEventSink.emitToolResultEvent.bind(defaultToolEventSink),
};

/**
 * Returns the appropriate {@link ToolEventSink} based on the test hook
 * environment variable.
 *
 * When `REMOTE_SWE_TEST_EVENT_DROP_ENABLED` is NOT set (or is not "true"),
 * returns {@link defaultToolEventSink} directly — zero overhead, identical
 * code path and object reference as production.
 *
 * When enabled, returns a wrapped sink that drops the FIRST `emitToolUseEvent`
 * call whose toolName is a message-rendering tool (sendMessageToUser,
 * sendImageToUser, sendFileToUser, sendMessageToUserIfNecessary — the same set
 * the webapp uses to decide which toolUse bubbles become visible message
 * bubbles). Non-message-rendering tools (execute_bash, think, etc.) pass
 * through unconditionally so the one-shot is never wasted on invisible events.
 *
 * Persist calls are never affected, so the data remains in DynamoDB — exactly
 * matching the real-world failure mode where a hidden browser tab misses the
 * push but can recover from the persisted state via lastMessageUpdate.
 *
 * Operational notes:
 * - One-shot is per-process (module-level state). All sessions on the same
 *   worker process share the flag; once dropped, it does not re-arm until
 *   the process restarts.
 * - A deploy (or runtime restart) re-arms the hook if the env var is still set.
 * - Removing the env var and restarting fully disables the hook (self-cleaning).
 */
export function resolveToolEventSink(): ToolEventSink {
  if (process.env[TEST_ENV_VAR] !== 'true') {
    return defaultToolEventSink;
  }

  if (!warningLogged) {
    warningLogged = true;
    console.warn(
      '[TEST-EVENT-DROP-HOOK] WARNING: Test event drop hook is ENABLED. ' +
        'This must NEVER be active in production. ' +
        `Set ${TEST_ENV_VAR}=true only in E2E test environments.`
    );
  }

  return wrappedSink;
}

/** Exported for testing only — resets module state between test cases. */
export function _resetTestEventDropState(): void {
  hasDroppedEvent = false;
  warningLogged = false;
}
