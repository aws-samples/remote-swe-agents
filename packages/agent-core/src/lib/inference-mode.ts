import { InferenceMode } from '../schema';
import { resolveModelConfig } from './model-resolver';

export interface InferenceModeContext {
  sessionInferenceMode?: InferenceMode;
  customAgentInferenceMode?: InferenceMode;
  envInferenceMode?: string;
  senderUserId?: string;
}

/**
 * Resolve the effective inference mode for an *existing* session (or a
 * pre-session context at session creation time for a custom agent without
 * an override).
 *
 * Priority: session > custom agent > env var > default (bedrock).
 *
 * User preferences are DELIBERATELY excluded from this chain. The user's
 * `preferences.inferenceMode` is the default used when *creating a new
 * session* (see `createSession`), and it is baked into the session at that
 * moment. Once the session exists, flipping user preferences must NOT
 * silently change the backend running behind an in-flight session or the UI
 * rendered for a legacy (pre-bake) session — that would retroactively put
 * every pre-existing Bedrock session into Kiro mode the moment the user
 * experiments with Kiro in Preferences.
 *
 * Consequently, legacy sessions (created before `inferenceMode` was
 * persisted) fall through to `bedrock`, which is the only safe assumption:
 * those sessions were run under the previous single-mode world where
 * Bedrock was the only backend.
 *
 * This helper is intentionally pure and synchronous so it can be reused
 * from both the worker runtime and the webapp SSR layer.
 *
 * @deprecated Use `resolveModelConfig` from './model-resolver' for new code.
 * This function is retained for backward compatibility and delegates to the
 * unified resolver internally.
 */
export const resolveInferenceMode = (ctx: InferenceModeContext): InferenceMode => {
  return resolveModelConfig({
    session: ctx.sessionInferenceMode ? { inferenceMode: ctx.sessionInferenceMode } : undefined,
    customAgent: ctx.customAgentInferenceMode ? { inferenceMode: ctx.customAgentInferenceMode } : undefined,
    env: ctx.envInferenceMode ? { inferenceMode: ctx.envInferenceMode } : undefined,
  }).inferenceMode;
};
