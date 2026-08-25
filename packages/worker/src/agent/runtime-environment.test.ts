import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { buildRuntimeEnvironmentBlock } from './orchestrator';
import { setProcessRuntimeType, _resetProcessRuntimeTypeForTesting } from '../runtime-type';
import type { CustomAgent, SessionItem } from '@remote-swe-agents/agent-core/schema';

const baseCustomAgent: CustomAgent = {
  PK: 'custom-agent',
  SK: '0',
  name: 'test',
  description: '',
  defaultModel: 'sonnet4',
  systemPrompt: '',
  tools: [],
  mcpConfig: '{}',
  runtimeType: 'ec2',
  createdAt: 0,
  updatedAt: 0,
};

describe('buildRuntimeEnvironmentBlock', () => {
  let originalInferenceMode: string | undefined;
  let originalWorkerRuntime: string | undefined;

  beforeEach(() => {
    originalInferenceMode = process.env.INFERENCE_MODE;
    originalWorkerRuntime = process.env.WORKER_RUNTIME;
    delete process.env.INFERENCE_MODE;
    delete process.env.WORKER_RUNTIME;
  });

  afterEach(() => {
    if (originalInferenceMode === undefined) {
      delete process.env.INFERENCE_MODE;
    } else {
      process.env.INFERENCE_MODE = originalInferenceMode;
    }
    if (originalWorkerRuntime === undefined) {
      delete process.env.WORKER_RUNTIME;
    } else {
      process.env.WORKER_RUNTIME = originalWorkerRuntime;
    }
  });

  describe('ground truth runtime type', () => {
    test('uses process runtime type from entry point, not DB', () => {
      setProcessRuntimeType('agent-core');
      const block = buildRuntimeEnvironmentBlock({
        session: { runtimeType: 'ec2' } as unknown as SessionItem,
        customAgent: { ...baseCustomAgent, runtimeType: 'ec2' },
      });
      expect(block).toContain('- Runtime type: agent-core');
      expect(block).not.toContain('- Runtime type: ec2');
    });

    test('ec2 process runtime type', () => {
      setProcessRuntimeType('ec2');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: baseCustomAgent,
      });
      expect(block).toContain('- Runtime type: ec2');
    });

    test('agent-core process runtime type', () => {
      setProcessRuntimeType('agent-core');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: baseCustomAgent,
      });
      expect(block).toContain('- Runtime type: agent-core');
    });
  });

  describe('C1: omit undefined fields gracefully', () => {
    test('omits runtime type line when process type is not set', () => {
      _resetProcessRuntimeTypeForTesting();
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent, runtimeType: undefined as unknown as 'ec2' | 'agent-core' },
      });
      expect(block).not.toContain('Runtime type');
      expect(block).not.toContain('undefined');
      expect(block).toContain('## Runtime Environment');
      expect(block).toContain('- Inference provider:');
    });

    test('never outputs literal string "undefined" for any field', () => {
      setProcessRuntimeType('ec2');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: baseCustomAgent,
      });
      expect(block).not.toContain('undefined');
    });

    test('still outputs provider and model even when runtime type is missing', () => {
      _resetProcessRuntimeTypeForTesting();
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent, inferenceMode: 'kiro-cli', kiroDefaultModel: 'claude-sonnet-5' },
      });
      expect(block).toBe('## Runtime Environment\n- Inference provider: kiro-cli\n- Model: claude-sonnet-5');
    });
  });

  describe('C2: model resolution with overrides', () => {
    test('bedrock modelOverride takes priority', () => {
      setProcessRuntimeType('ec2');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent, bedrockDefaultModel: 'sonnet4' },
        overrides: { modelOverride: 'opus5' },
      });
      expect(block).toContain('- Model: opus5');
    });

    test('kiro modelOverride takes priority', () => {
      setProcessRuntimeType('agent-core');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent, inferenceMode: 'kiro-cli', kiroDefaultModel: 'claude-sonnet-5' },
        overrides: { kiroModelOverride: 'claude-opus-5' },
      });
      expect(block).toContain('- Model: claude-opus-5');
    });

    test('userPreferences are applied when no override', () => {
      setProcessRuntimeType('ec2');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent, inferenceMode: 'kiro-cli' },
        userPreferences: { kiroDefaultModel: 'claude-opus-4.8' },
      });
      expect(block).toContain('- Model: claude-opus-4.8');
    });

    test('override beats userPreferences', () => {
      setProcessRuntimeType('ec2');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent, inferenceMode: 'kiro-cli' },
        overrides: { kiroModelOverride: 'claude-sonnet-5' },
        userPreferences: { kiroDefaultModel: 'claude-opus-4.8' },
      });
      expect(block).toContain('- Model: claude-sonnet-5');
    });
  });

  describe('inference mode resolution', () => {
    test('ec2 + bedrock (default)', () => {
      setProcessRuntimeType('ec2');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent },
      });
      expect(block).toContain('## Runtime Environment');
      expect(block).toContain('- Runtime type: ec2');
      expect(block).toContain('- Inference provider: bedrock');
      expect(block).toContain('- Model: sonnet4');
    });

    test('agent-core + bedrock', () => {
      setProcessRuntimeType('agent-core');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent, bedrockDefaultModel: 'opus5' },
      });
      expect(block).toContain('- Runtime type: agent-core');
      expect(block).toContain('- Inference provider: bedrock');
      expect(block).toContain('- Model: opus5');
    });

    test('ec2 + kiro-cli with auto model', () => {
      setProcessRuntimeType('ec2');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent, inferenceMode: 'kiro-cli' },
      });
      expect(block).toContain('- Runtime type: ec2');
      expect(block).toContain('- Inference provider: kiro-cli');
      expect(block).toContain('- Model: auto (dynamically selected)');
    });

    test('agent-core + kiro-cli with specific model', () => {
      setProcessRuntimeType('agent-core');
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: {
          ...baseCustomAgent,
          inferenceMode: 'kiro-cli',
          kiroDefaultModel: 'claude-sonnet-5',
        },
      });
      expect(block).toContain('- Runtime type: agent-core');
      expect(block).toContain('- Inference provider: kiro-cli');
      expect(block).toContain('- Model: claude-sonnet-5');
    });
  });

  describe('session-level settings', () => {
    test('session inferenceMode overrides agent', () => {
      setProcessRuntimeType('ec2');
      const block = buildRuntimeEnvironmentBlock({
        session: {
          inferenceMode: 'kiro-cli',
          kiroDefaultModel: 'claude-opus-5',
        } as unknown as SessionItem,
        customAgent: { ...baseCustomAgent, inferenceMode: 'bedrock' },
      });
      expect(block).toContain('- Inference provider: kiro-cli');
      expect(block).toContain('- Model: claude-opus-5');
    });

    test('session bedrockDefaultModel overrides agent model', () => {
      setProcessRuntimeType('ec2');
      const block = buildRuntimeEnvironmentBlock({
        session: {
          bedrockDefaultModel: 'opus4.8',
        } as unknown as SessionItem,
        customAgent: { ...baseCustomAgent, bedrockDefaultModel: 'sonnet4' },
      });
      expect(block).toContain('- Model: opus4.8');
    });
  });

  describe('env fallback', () => {
    test('INFERENCE_MODE env var fallback when neither session nor agent sets it', () => {
      setProcessRuntimeType('ec2');
      process.env.INFERENCE_MODE = 'kiro-cli';
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: { ...baseCustomAgent },
      });
      expect(block).toContain('- Inference provider: kiro-cli');
    });

    test('WORKER_RUNTIME env var is used as fallback when setProcessRuntimeType not called', () => {
      _resetProcessRuntimeTypeForTesting();
      process.env.WORKER_RUNTIME = 'agent-core';
      const block = buildRuntimeEnvironmentBlock({
        session: undefined,
        customAgent: baseCustomAgent,
      });
      expect(block).toContain('- Runtime type: agent-core');
    });
  });
});
