import { InferenceMode, KiroModelId, ModelType, modelConfigs, kiroModelConfigs } from '../schema';
import { defaultAgentConfig } from '../schema/agent';

/**
 * Flat model-field input that a single source (session, custom agent, or user
 * preferences) may carry. Supports BOTH the new symmetric field names AND the
 * legacy asymmetric names for backward compatibility.
 *
 * Writers should always use the new fields (`bedrockDefaultModel`,
 * `kiroDefaultModel`). The legacy fields (`defaultModel`, `kiroModel`) are
 * read-only fallbacks for records persisted before this refactor.
 */
export interface ModelFields {
  // ── New (preferred) ──
  bedrockDefaultModel?: ModelType;
  kiroDefaultModel?: KiroModelId | string;
  // ── Legacy (fallback) ──
  defaultModel?: ModelType;
  kiroModel?: KiroModelId | string;
  // ── Provider switch (unchanged) ──
  inferenceMode?: InferenceMode;
}

/**
 * Per-message overrides that take highest priority. These come from the UI's
 * model selector on individual messages and are NOT renamed (they are already
 * qualified: `modelOverride` for bedrock, `kiroModelOverride` for kiro).
 */
export interface ModelOverrides {
  modelOverride?: ModelType | string;
  kiroModelOverride?: KiroModelId | string;
}

/**
 * Full context needed to resolve the effective model configuration for a
 * session. Each source is optional and may carry any combination of new or
 * legacy fields.
 *
 * Priority (highest → lowest):
 *   overrides → session → customAgent → userPreferences → env → defaults
 *
 * User preferences are deliberately limited: they are only applied at session
 * creation time (baked in). For existing sessions the resolver must NOT
 * consult user preferences for inference mode (to avoid retroactively changing
 * the backend of a live session).
 */
export interface ModelResolutionContext {
  overrides?: ModelOverrides;
  session?: Partial<ModelFields>;
  customAgent?: Partial<ModelFields>;
  userPreferences?: Partial<ModelFields>;
  env?: { inferenceMode?: string };
}

export interface ModelResolutionResult {
  inferenceMode: InferenceMode;
  bedrockModel: ModelType;
  kiroModel: KiroModelId;
}

/**
 * Resolve the effective bedrock model from overrides + chain of sources.
 * Override takes top priority, then new field (`bedrockDefaultModel`) over
 * legacy (`defaultModel`) within each source.
 */
const resolveBedrockModel = (ctx: ModelResolutionContext): ModelType => {
  if (ctx.overrides?.modelOverride) {
    const override = ctx.overrides.modelOverride as ModelType;
    if (modelConfigs[override]) return override;
  }
  const sources = [ctx.session, ctx.customAgent, ctx.userPreferences];
  for (const src of sources) {
    if (!src) continue;
    if (src.bedrockDefaultModel) return src.bedrockDefaultModel;
    if (src.defaultModel) return src.defaultModel;
  }
  return defaultAgentConfig.defaultModel;
};

/**
 * Resolve the effective kiro model from overrides + chain of sources.
 * Override takes top priority, then new field (`kiroDefaultModel`) over
 * legacy (`kiroModel`) within each source.
 */
const resolveKiroModel = (ctx: ModelResolutionContext): KiroModelId => {
  if (ctx.overrides?.kiroModelOverride) {
    const override = ctx.overrides.kiroModelOverride as KiroModelId;
    if (kiroModelConfigs[override]) return override;
  }
  const sources = [ctx.session, ctx.customAgent, ctx.userPreferences];
  for (const src of sources) {
    if (!src) continue;
    if (src.kiroDefaultModel) return src.kiroDefaultModel as KiroModelId;
    if (src.kiroModel) return src.kiroModel as KiroModelId;
  }
  return 'auto';
};

/**
 * Resolve which inference provider to use.
 * Priority: session > customAgent > env > default (bedrock).
 *
 * This replaces the standalone `resolveInferenceMode` function with the same
 * logic but integrated into the unified resolver.
 */
const resolveProvider = (ctx: ModelResolutionContext): InferenceMode => {
  if (ctx.session?.inferenceMode) return ctx.session.inferenceMode;
  if (ctx.customAgent?.inferenceMode) return ctx.customAgent.inferenceMode;
  if (ctx.env?.inferenceMode === 'kiro-cli') return 'kiro-cli';
  return 'bedrock';
};

/**
 * Single entry point for resolving the full model configuration.
 *
 * Returns:
 * - `inferenceMode`: which provider is active ('bedrock' | 'kiro-cli')
 * - `bedrockModel`: the resolved Bedrock model ID
 * - `kiroModel`: the resolved Kiro model ID
 *
 * Both model selections are always resolved (regardless of which provider is
 * active) so that switching providers preserves both selections.
 *
 * Resolution precedence (per field):
 * 1. Per-message override (highest — from UI model selector)
 * 2. Session-level setting (baked at creation)
 * 3. Custom agent setting
 * 4. User preferences
 * 5. Defaults (lowest)
 *
 * Within each source, new format fields (`bedrockDefaultModel`,
 * `kiroDefaultModel`) take priority over legacy (`defaultModel`, `kiroModel`).
 * Legacy-only records are seamlessly handled without migration.
 */
export const resolveModelConfig = (ctx: ModelResolutionContext): ModelResolutionResult => {
  return {
    inferenceMode: resolveProvider(ctx),
    bedrockModel: resolveBedrockModel(ctx),
    kiroModel: resolveKiroModel(ctx),
  };
};
