import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnContext } from '@remote-swe-agents/agent-core/lib';

vi.mock('@remote-swe-agents/agent-core/lib', async () => {
  const actual = await vi.importActual('@remote-swe-agents/agent-core/lib');
  return {
    ...actual,
    getPreferences: vi.fn(),
    sendSystemMessage: vi.fn(),
  };
});

import { getPreferences } from '@remote-swe-agents/agent-core/lib';
import { resolveModelTypes } from '../bedrock-strands-agent-loop';

const mockGetPreferences = vi.mocked(getPreferences);

function makeTurnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    workerId: 'test-worker',
    session: undefined,
    customAgent: {
      PK: 'custom-agent',
      SK: '0',
      name: 'test',
      description: '',
      defaultModel: 'sonnet4.6',
      bedrockDefaultModel: 'sonnet4.6',
      systemPrompt: '',
      tools: [],
      mcpConfig: '{"mcpServers":{}}',
      runtimeType: 'agent-core',
      createdAt: 0,
      updatedAt: 0,
    },
    history: [],
    systemPrompt: '',
    cwd: '/tmp',
    userMessage: '',
    cancellationToken: { isCancelled: false, onCancel: () => () => {} } as any,
    userSkills: [],
    ...overrides,
  } as TurnContext;
}

const defaultPrefs = {
  PK: 'global-config' as const,
  SK: 'general' as const,
  modelOverride: undefined as any,
  enableLinkInPr: false,
  defaultAgentName: '',
  defaultAgentIconKey: '',
  updatedAt: 0,
};

describe('resolveModelTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses customAgent default when no overrides, no session, no preferences', async () => {
    mockGetPreferences.mockResolvedValue({ ...defaultPrefs });

    const ctx = makeTurnContext();
    const result = await resolveModelTypes(ctx);

    expect(result).toEqual(['sonnet4.6']);
  });

  it('userPreferences.modelOverride is low-priority: session.bedrockDefaultModel wins', async () => {
    mockGetPreferences.mockResolvedValue({ ...defaultPrefs, modelOverride: 'opus5' });

    const ctx = makeTurnContext({
      session: { bedrockDefaultModel: 'sonnet5' } as any,
    });
    const result = await resolveModelTypes(ctx);

    expect(result).toEqual(['sonnet5']);
  });

  it('userPreferences.modelOverride applies when no session/customAgent model set', async () => {
    mockGetPreferences.mockResolvedValue({ ...defaultPrefs, modelOverride: 'opus5' });

    const ctx = makeTurnContext({
      session: { bedrockDefaultModel: undefined } as any,
      customAgent: {
        PK: 'custom-agent',
        SK: '0',
        name: 'test',
        description: '',
        defaultModel: undefined as any,
        bedrockDefaultModel: undefined as any,
        systemPrompt: '',
        tools: [],
        mcpConfig: '{"mcpServers":{}}',
        runtimeType: 'agent-core',
        createdAt: 0,
        updatedAt: 0,
      },
    });
    const result = await resolveModelTypes(ctx);

    expect(result).toEqual(['opus5']);
  });

  it('per-message override on last user message takes highest priority', async () => {
    mockGetPreferences.mockResolvedValue({ ...defaultPrefs, modelOverride: 'opus5' });

    const ctx = makeTurnContext({
      session: { bedrockDefaultModel: 'sonnet5' } as any,
      history: [{ role: 'user', content: '[]', modelOverride: 'haiku4.5' } as any],
    });
    const result = await resolveModelTypes(ctx);

    expect(result).toEqual(['haiku4.5']);
  });

  it('only the LAST user message override matters, not historical ones', async () => {
    mockGetPreferences.mockResolvedValue({ ...defaultPrefs });

    const ctx = makeTurnContext({
      session: { bedrockDefaultModel: 'sonnet5' } as any,
      history: [
        { role: 'user', content: '[]', modelOverride: 'opus5' } as any,
        { role: 'assistant', content: '[]' } as any,
        { role: 'user', content: '[]' } as any,
      ],
    });
    const result = await resolveModelTypes(ctx);

    // Last user message has no override → session model wins
    expect(result).toEqual(['sonnet5']);
  });

  it('falls back to customAgent default for unknown model types', async () => {
    mockGetPreferences.mockResolvedValue({ ...defaultPrefs });

    const ctx = makeTurnContext({
      history: [{ role: 'user', content: '[]', modelOverride: 'nonexistent-model-xyz' } as any],
    });
    const result = await resolveModelTypes(ctx);

    expect(result).toEqual(['sonnet4.6']);
  });
});
