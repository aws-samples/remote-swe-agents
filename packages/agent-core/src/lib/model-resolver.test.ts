import { describe, expect, test } from 'vitest';
import { resolveModelConfig } from './model-resolver';

describe('resolveModelConfig', () => {
  describe('inferenceMode resolution', () => {
    test('defaults to bedrock when nothing is set', () => {
      expect(resolveModelConfig({}).inferenceMode).toBe('bedrock');
    });

    test('session setting takes highest priority', () => {
      expect(
        resolveModelConfig({
          session: { inferenceMode: 'kiro-cli' },
          customAgent: { inferenceMode: 'bedrock' },
          env: { inferenceMode: 'bedrock' },
        }).inferenceMode
      ).toBe('kiro-cli');
    });

    test('customAgent overrides env', () => {
      expect(
        resolveModelConfig({
          customAgent: { inferenceMode: 'kiro-cli' },
          env: { inferenceMode: 'bedrock' },
        }).inferenceMode
      ).toBe('kiro-cli');
    });

    test('env kiro-cli is honoured when no session/agent setting', () => {
      expect(
        resolveModelConfig({
          env: { inferenceMode: 'kiro-cli' },
        }).inferenceMode
      ).toBe('kiro-cli');
    });

    test('non-kiro-cli env values fall through to bedrock default', () => {
      expect(
        resolveModelConfig({
          env: { inferenceMode: 'something-else' },
        }).inferenceMode
      ).toBe('bedrock');
    });
  });

  describe('bedrockModel resolution', () => {
    test('defaults to defaultAgentConfig.defaultModel when nothing is set', () => {
      expect(resolveModelConfig({}).bedrockModel).toBe('sonnet4.6');
    });

    test('new field bedrockDefaultModel takes priority over legacy defaultModel within same source', () => {
      expect(
        resolveModelConfig({
          customAgent: {
            bedrockDefaultModel: 'sonnet4.6',
            defaultModel: 'sonnet3.7',
          },
        }).bedrockModel
      ).toBe('sonnet4.6');
    });

    test('legacy defaultModel is used when bedrockDefaultModel is absent (backward compat)', () => {
      expect(
        resolveModelConfig({
          customAgent: {
            defaultModel: 'sonnet3.7',
          },
        }).bedrockModel
      ).toBe('sonnet3.7');
    });

    test('session setting takes priority over customAgent', () => {
      expect(
        resolveModelConfig({
          session: { bedrockDefaultModel: 'haiku4.5' },
          customAgent: { bedrockDefaultModel: 'opus4.8' },
        }).bedrockModel
      ).toBe('haiku4.5');
    });

    test('override takes highest priority', () => {
      expect(
        resolveModelConfig({
          overrides: { modelOverride: 'haiku4.5' },
          session: { bedrockDefaultModel: 'opus4.8' },
          customAgent: { bedrockDefaultModel: 'sonnet4.6' },
        }).bedrockModel
      ).toBe('haiku4.5');
    });

    test('invalid override model is ignored', () => {
      expect(
        resolveModelConfig({
          overrides: { modelOverride: 'nonexistent-model' },
          customAgent: { bedrockDefaultModel: 'sonnet4.6' },
        }).bedrockModel
      ).toBe('sonnet4.6');
    });
  });

  describe('kiroModel resolution', () => {
    test('defaults to auto when nothing is set', () => {
      expect(resolveModelConfig({}).kiroModel).toBe('auto');
    });

    test('new field kiroDefaultModel takes priority over legacy kiroModel within same source', () => {
      expect(
        resolveModelConfig({
          customAgent: {
            kiroDefaultModel: 'claude-opus-4.8',
            kiroModel: 'claude-haiku-4.5',
          },
        }).kiroModel
      ).toBe('claude-opus-4.8');
    });

    test('legacy kiroModel is used when kiroDefaultModel is absent (backward compat)', () => {
      expect(
        resolveModelConfig({
          customAgent: {
            kiroModel: 'claude-haiku-4.5',
          },
        }).kiroModel
      ).toBe('claude-haiku-4.5');
    });

    test('session setting takes priority over customAgent', () => {
      expect(
        resolveModelConfig({
          session: { kiroDefaultModel: 'deepseek-3.2' },
          customAgent: { kiroDefaultModel: 'claude-opus-4.8' },
        }).kiroModel
      ).toBe('deepseek-3.2');
    });

    test('override takes highest priority', () => {
      expect(
        resolveModelConfig({
          overrides: { kiroModelOverride: 'glm-5' },
          session: { kiroDefaultModel: 'claude-opus-4.8' },
          customAgent: { kiroDefaultModel: 'deepseek-3.2' },
        }).kiroModel
      ).toBe('glm-5');
    });

    test('userPreferences is consulted when session and agent have nothing', () => {
      expect(
        resolveModelConfig({
          userPreferences: { kiroDefaultModel: 'minimax-m2.5' },
        }).kiroModel
      ).toBe('minimax-m2.5');
    });
  });

  describe('bedrock↔kiro switching preserves both selections', () => {
    test('both models are always resolved regardless of active provider', () => {
      const result = resolveModelConfig({
        session: {
          inferenceMode: 'bedrock',
          bedrockDefaultModel: 'sonnet4.6',
          kiroDefaultModel: 'claude-opus-4.8',
        },
      });
      expect(result.inferenceMode).toBe('bedrock');
      expect(result.bedrockModel).toBe('sonnet4.6');
      expect(result.kiroModel).toBe('claude-opus-4.8');
    });

    test('switching to kiro-cli does not lose bedrock model', () => {
      const result = resolveModelConfig({
        session: {
          inferenceMode: 'kiro-cli',
          bedrockDefaultModel: 'sonnet4.6',
          kiroDefaultModel: 'claude-opus-4.8',
        },
      });
      expect(result.inferenceMode).toBe('kiro-cli');
      expect(result.bedrockModel).toBe('sonnet4.6');
      expect(result.kiroModel).toBe('claude-opus-4.8');
    });
  });

  describe('legacy format fallback (no new fields)', () => {
    test('agent with only legacy fields resolves correctly', () => {
      const result = resolveModelConfig({
        session: {
          inferenceMode: 'kiro-cli',
        },
        customAgent: {
          defaultModel: 'sonnet3.7',
          kiroModel: 'claude-haiku-4.5',
        },
      });
      expect(result.inferenceMode).toBe('kiro-cli');
      expect(result.bedrockModel).toBe('sonnet3.7');
      expect(result.kiroModel).toBe('claude-haiku-4.5');
    });

    test('mixed new and legacy fields across sources', () => {
      const result = resolveModelConfig({
        session: { kiroDefaultModel: 'deepseek-3.2' },
        customAgent: { defaultModel: 'sonnet3.7' },
      });
      expect(result.bedrockModel).toBe('sonnet3.7');
      expect(result.kiroModel).toBe('deepseek-3.2');
    });
  });

  describe('partial update safety', () => {
    test('undefined fields do not shadow lower-priority sources', () => {
      const result = resolveModelConfig({
        session: { bedrockDefaultModel: undefined, kiroDefaultModel: undefined },
        customAgent: {
          bedrockDefaultModel: 'sonnet4.6',
          kiroDefaultModel: 'claude-opus-4.8',
        },
      });
      expect(result.bedrockModel).toBe('sonnet4.6');
      expect(result.kiroModel).toBe('claude-opus-4.8');
    });

    test('empty session does not override agent settings', () => {
      const result = resolveModelConfig({
        session: {},
        customAgent: {
          bedrockDefaultModel: 'haiku4.5',
          kiroDefaultModel: 'glm-5',
          inferenceMode: 'kiro-cli',
        },
      });
      expect(result.inferenceMode).toBe('kiro-cli');
      expect(result.bedrockModel).toBe('haiku4.5');
      expect(result.kiroModel).toBe('glm-5');
    });
  });

  describe('B-1: session bedrockDefaultModel is respected in bedrock runtime', () => {
    test('session bedrockDefaultModel overrides customAgent when both are present', () => {
      const result = resolveModelConfig({
        session: { bedrockDefaultModel: 'haiku4.5' },
        customAgent: { bedrockDefaultModel: 'opus4.8', defaultModel: 'sonnet3.7' },
      });
      expect(result.bedrockModel).toBe('haiku4.5');
    });

    test('session legacy defaultModel is used when session has no bedrockDefaultModel', () => {
      const result = resolveModelConfig({
        session: { defaultModel: 'sonnet4.6' },
        customAgent: { bedrockDefaultModel: 'opus4.8' },
      });
      expect(result.bedrockModel).toBe('sonnet4.6');
    });
  });

  describe('B-2: legacy updateAgent({defaultModel}) reflects correctly', () => {
    test('when bedrockDefaultModel is set via reverse sync, resolver picks it up', () => {
      // Simulates the scenario where updateAgent({defaultModel: 'sonnet4.6'})
      // triggers reverse sync to also set bedrockDefaultModel: 'sonnet4.6'
      const agentAfterSync = {
        defaultModel: 'sonnet4.6' as const,
        bedrockDefaultModel: 'sonnet4.6' as const,
      };
      const result = resolveModelConfig({ customAgent: agentAfterSync });
      expect(result.bedrockModel).toBe('sonnet4.6');
    });

    test('bedrockDefaultModel takes priority over stale defaultModel', () => {
      // If an agent had stale bedrockDefaultModel='opus4.8' and user updates
      // defaultModel='sonnet4.6' via legacy API, reverse sync should update
      // bedrockDefaultModel too. But if it didn't, bedrockDefaultModel wins.
      const result = resolveModelConfig({
        customAgent: {
          bedrockDefaultModel: 'opus4.8',
          defaultModel: 'sonnet4.6',
        },
      });
      expect(result.bedrockModel).toBe('opus4.8');
    });
  });

  describe('S-2: invalid kiroModelOverride is ignored', () => {
    test('invalid kiroModelOverride falls through to source chain', () => {
      const result = resolveModelConfig({
        overrides: { kiroModelOverride: 'nonexistent-kiro-model' },
        customAgent: { kiroDefaultModel: 'claude-opus-4.8' },
      });
      expect(result.kiroModel).toBe('claude-opus-4.8');
    });

    test('valid kiroModelOverride is respected', () => {
      const result = resolveModelConfig({
        overrides: { kiroModelOverride: 'deepseek-3.2' },
        customAgent: { kiroDefaultModel: 'claude-opus-4.8' },
      });
      expect(result.kiroModel).toBe('deepseek-3.2');
    });
  });
});
