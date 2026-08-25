/**
 * Extracted invoke loop with error taxonomy + circuit breaker + error feedback.
 *
 * Testable in isolation by injecting deps (invoke callable, emit/persist stubs).
 * Production wiring lives in bedrockStrandsAgentLoop; this module owns the
 * retry/breaker/feedback logic only.
 *
 * State is a shared mutable object so that external hooks (e.g. BeforeToolsEvent
 * resetting the breaker on a successful model call) can mutate mid-loop.
 */
import type { Message as BedrockMessage } from '@aws-sdk/client-bedrock-runtime';
import {
  categorizeError,
  isPermanentError,
  getPermanentErrorHint,
  getRecoveryHint,
  MAX_CONSECUTIVE_ERRORS,
} from '../error-taxonomy';

export interface InvokeLoopDeps {
  invoke: (arg: unknown) => Promise<unknown>;
  saveConversationHistory: (workerId: string, msg: BedrockMessage, tokenCount: number, tag: string) => Promise<unknown>;
  sendWebappEvent: (workerId: string, event: any) => Promise<void>;
  sendSystemMessage: (
    workerId: string,
    msg: string,
    appendWebappUrl: boolean,
    skipWebappEmit?: boolean,
    messageSK?: string
  ) => Promise<void>;
  /**
   * Persist an unrecoverable-error notification as an 'assistant' bubble so it
   * survives page reload, returning its DDB SK (best-effort: undefined on
   * failure). Injected so the loop can persist-then-notify with the same SK,
   * matching main's index.ts parity (e44b8507). Mocked as a true external in
   * tests; the loop itself owns the persist-before-notify ordering.
   */
  persistErrorBubble: (workerId: string, errorText: string) => Promise<string | undefined>;
  isCancelled: () => boolean;
  workerId: string;
  slackUserId?: string;
}

export interface InvokeLoopState {
  consecutiveErrorCount: number;
  lastErrorType: string;
}

/**
 * Runs the invoke loop: calls `deps.invoke(invokeArg)` and on non-permanent
 * error, injects errorFeedback as the next invokeArg. Stops on:
 *  - success (returns result)
 *  - permanent error (returns null, emits willRetry:false)
 *  - circuit breaker trip (returns null after MAX_CONSECUTIVE_ERRORS)
 *  - cancellation (rethrows)
 *
 * `state` is mutated in-place and also readable by external hooks that share
 * the same object reference (e.g. BeforeToolsEvent resets breaker mid-loop).
 */
export async function runInvokeLoop(
  deps: InvokeLoopDeps,
  initialInvokeArg: unknown,
  state: InvokeLoopState
): Promise<unknown> {
  let invokeArg = initialInvokeArg;

  while (true) {
    try {
      const r = await deps.invoke(invokeArg);
      state.consecutiveErrorCount = 0;
      state.lastErrorType = '';
      return r;
    } catch (e) {
      if (deps.isCancelled()) throw e;

      const errorType = categorizeError(e);
      const errorMessage = e instanceof Error ? e.message : String(e);

      if (errorType === state.lastErrorType) {
        state.consecutiveErrorCount++;
      } else {
        state.consecutiveErrorCount = 1;
        state.lastErrorType = errorType;
      }

      console.log(`[invokeLoop] error (${errorType}, consecutive: ${state.consecutiveErrorCount}): ${errorMessage}`);

      // Permanent error — stop immediately
      if (isPermanentError(errorType, errorMessage)) {
        const hint = getPermanentErrorHint(errorMessage);
        const { workerId, slackUserId } = deps;
        const userNotification = `An error occurred. This error will not be resolved by retrying, so the turn was stopped.\n\nCause: ${hint}\n\nDetails: ${errorMessage}`;
        const errorText = slackUserId ? `<@${slackUserId}> ${userNotification}` : userNotification;
        // Persist as an 'assistant' bubble first, then notify with the same SK
        // so the notification survives page reload.
        const messageSK = await deps.persistErrorBubble(workerId, errorText);
        await deps.sendSystemMessage(workerId, errorText, true, false, messageSK);
        await deps.sendWebappEvent(workerId, {
          type: 'agentError',
          errorType,
          errorMessage,
          consecutiveCount: state.consecutiveErrorCount,
          willRetry: false,
        });
        return null;
      }

      // Circuit breaker
      if (state.consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        const { workerId, slackUserId } = deps;
        const userNotification = `The agent encountered the same error ${MAX_CONSECUTIVE_ERRORS} times consecutively and stopped to avoid an infinite loop.\n\nError type: ${errorType}\nDetails: ${errorMessage}\n\nPlease review and try again.`;
        const cbText = slackUserId ? `<@${slackUserId}> ${userNotification}` : userNotification;
        // Persist as an 'assistant' bubble first, then notify with the same SK
        // so the notification survives page reload.
        const messageSK = await deps.persistErrorBubble(workerId, cbText);
        await deps.sendSystemMessage(workerId, cbText, true, false, messageSK);
        return null;
      }

      // Inject error feedback as the next invoke argument
      const recoveryHint = getRecoveryHint(errorType, errorMessage);
      const errorFeedbackText = `[SYSTEM ERROR FEEDBACK] An error occurred during your last response generation. Please adjust your approach and try again.\n\nError type: ${errorType}\nDetails: ${errorMessage}\n\n${recoveryHint}`;

      const errorFeedbackMessage: BedrockMessage = {
        role: 'user',
        content: [{ text: errorFeedbackText }],
      };
      await deps.saveConversationHistory(deps.workerId, errorFeedbackMessage, 0, 'errorFeedback');

      await deps.sendWebappEvent(deps.workerId, {
        type: 'agentError',
        errorType,
        errorMessage,
        consecutiveCount: state.consecutiveErrorCount,
        willRetry: true,
      });

      // Retry with error feedback as the invoke argument (MessageData[] pattern)
      invokeArg = [{ role: 'user' as const, content: [{ text: errorFeedbackText }] }];
      continue;
    }
  }
}
