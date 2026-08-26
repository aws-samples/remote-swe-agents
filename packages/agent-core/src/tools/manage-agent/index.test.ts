import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockGetCustomAgent = vi.fn();
const mockUpdateCustomAgent = vi.fn();
const mockCreateCustomAgent = vi.fn();
const mockDeleteCustomAgent = vi.fn();
const mockGetCustomAgents = vi.fn();
const mockSavePendingCreateAgent = vi.fn();

vi.mock('../../lib/custom-agent', () => ({
  getCustomAgent: (...args: any[]) => mockGetCustomAgent(...args),
  getCustomAgents: (...args: any[]) => mockGetCustomAgents(...args),
  createCustomAgent: (...args: any[]) => mockCreateCustomAgent(...args),
  updateCustomAgent: (...args: any[]) => mockUpdateCustomAgent(...args),
  deleteCustomAgent: (...args: any[]) => mockDeleteCustomAgent(...args),
}));

vi.mock('../confirm-create-agent', () => ({
  savePendingCreateAgent: (...args: any[]) => mockSavePendingCreateAgent(...args),
}));

import { createAgentTool, updateAgentTool } from './index';
import type { GlobalPreferences } from '../../schema';

const existingAgent = {
  PK: 'custom-agent',
  SK: 'agent-1',
  name: 'Original',
  description: 'Original description',
  defaultModel: 'sonnet4.6',
  systemPrompt: 'Original prompt',
  tools: ['toolA'],
  useAllTools: false,
  mcpConfig: '{"mcpServers":{}}',
  runtimeType: 'agent-core',
  includeDefaultKnowledge: true,
  createdAt: 1,
  updatedAt: 2,
};

const context = {
  workerId: 'worker-1',
  toolUseId: 'tool-use-1',
  globalPreferences: {} as GlobalPreferences,
};

describe('updateAgentTool (partial update handler)', () => {
  beforeEach(() => {
    mockGetCustomAgent.mockReset();
    mockUpdateCustomAgent.mockReset();
    mockGetCustomAgent.mockResolvedValue(existingAgent);
    mockUpdateCustomAgent.mockImplementation(async (_sk: string, updates: any) => ({
      ...existingAgent,
      ...updates,
    }));
  });

  test('passes only explicitly provided fields to updateCustomAgent', async () => {
    // WHEN
    await updateAgentTool.handler({ agentId: 'agent-1', description: 'Changed' } as any, context);

    // THEN
    expect(mockUpdateCustomAgent).toHaveBeenCalledTimes(1);
    const [sk, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(sk).toBe('agent-1');
    expect(data).toEqual({ description: 'Changed' });
    // Ensure agentId is stripped and no defaults were injected
    expect(data).not.toHaveProperty('agentId');
    expect(data).not.toHaveProperty('name');
    expect(data).not.toHaveProperty('mcpConfig');
    expect(data).not.toHaveProperty('tools');
    expect(data).not.toHaveProperty('useAllTools');
    expect(data).not.toHaveProperty('includeDefaultKnowledge');
  });

  test('forwards undefined fields verbatim (lib layer is responsible for skipping them)', async () => {
    // WHEN
    await updateAgentTool.handler(
      {
        agentId: 'agent-1',
        name: 'New Name',
        description: undefined,
        tools: undefined,
        useAllTools: undefined,
        mcpConfig: undefined,
        includeDefaultKnowledge: undefined,
      } as any,
      context
    );

    // THEN
    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    // agentId must be stripped; the rest of the payload is passed through as-is.
    // The lib layer (updateCustomAgent) is responsible for skipping undefined keys.
    expect(data).not.toHaveProperty('agentId');
    expect(data.name).toBe('New Name');
    expect(data.description).toBeUndefined();
    expect(data.tools).toBeUndefined();
  });

  test('allows clearing tools by passing an empty array explicitly', async () => {
    // WHEN
    await updateAgentTool.handler({ agentId: 'agent-1', tools: [] } as any, context);

    // THEN
    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(data).toEqual({ tools: [] });
  });

  test('returns not-found message when agent does not exist', async () => {
    // GIVEN
    mockGetCustomAgent.mockResolvedValueOnce(undefined);

    // WHEN
    const result = await updateAgentTool.handler({ agentId: 'missing' } as any, context);

    // THEN
    expect(result).toContain('not found');
    expect(mockUpdateCustomAgent).not.toHaveBeenCalled();
  });

  test('passes multiple fields together when provided', async () => {
    // WHEN
    await updateAgentTool.handler(
      {
        agentId: 'agent-1',
        name: 'Renamed',
        systemPrompt: 'New prompt',
        useAllTools: true,
      } as any,
      context
    );

    // THEN
    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(data).toEqual({
      name: 'Renamed',
      systemPrompt: 'New prompt',
      useAllTools: true,
    });
  });

  test('forwards parentAgentId when provided', async () => {
    // GIVEN: parent agent exists
    mockGetCustomAgent
      .mockResolvedValueOnce(existingAgent) // existing lookup for input.agentId
      .mockResolvedValueOnce({ ...existingAgent, SK: 'parent-agent-sk', name: 'Parent' });

    // WHEN
    await updateAgentTool.handler({ agentId: 'agent-1', parentAgentId: 'parent-agent-sk' } as any, context);

    // THEN
    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(data).toEqual({ parentAgentId: 'parent-agent-sk' });
  });

  test('rejects self-referential parentAgentId on update', async () => {
    // WHEN
    const result = await updateAgentTool.handler({ agentId: 'agent-1', parentAgentId: 'agent-1' } as any, context);

    // THEN
    expect(result).toMatch(/cannot reference itself/);
    expect(mockUpdateCustomAgent).not.toHaveBeenCalled();
  });

  test('rejects non-existent parentAgentId on update', async () => {
    // GIVEN: existing agent lookup returns the agent; parent lookup returns undefined
    mockGetCustomAgent.mockReset();
    mockGetCustomAgent.mockResolvedValueOnce(existingAgent).mockResolvedValueOnce(undefined);

    // WHEN
    const result = await updateAgentTool.handler(
      { agentId: 'agent-1', parentAgentId: 'missing-parent' } as any,
      context
    );

    // THEN
    expect(result).toMatch(/does not exist/);
    expect(result).toContain('missing-parent');
    expect(mockUpdateCustomAgent).not.toHaveBeenCalled();
  });

  test('forwards inferenceMode when provided', async () => {
    await updateAgentTool.handler({ agentId: 'agent-1', inferenceMode: 'kiro-cli' } as any, context);

    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(data).toEqual({ inferenceMode: 'kiro-cli' });
  });

  test('forwards kiroModel when provided (with reverse sync to kiroDefaultModel)', async () => {
    await updateAgentTool.handler({ agentId: 'agent-1', kiroModel: 'claude-opus-4.8' } as any, context);

    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(data).toEqual({ kiroModel: 'claude-opus-4.8', kiroDefaultModel: 'claude-opus-4.8' });
  });

  test('does not include kiroModel when not provided (partial update)', async () => {
    await updateAgentTool.handler({ agentId: 'agent-1', name: 'Renamed' } as any, context);

    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(data).not.toHaveProperty('kiroModel');
  });

  test('B-2: legacy defaultModel update triggers reverse sync to bedrockDefaultModel', async () => {
    await updateAgentTool.handler({ agentId: 'agent-1', defaultModel: 'sonnet4.6' } as any, context);

    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(data.defaultModel).toBe('sonnet4.6');
    expect(data.bedrockDefaultModel).toBe('sonnet4.6');
  });

  test('B-2: legacy kiroModel update triggers reverse sync to kiroDefaultModel', async () => {
    await updateAgentTool.handler({ agentId: 'agent-1', kiroModel: 'claude-opus-4.8' } as any, context);

    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(data.kiroModel).toBe('claude-opus-4.8');
    expect(data.kiroDefaultModel).toBe('claude-opus-4.8');
  });

  test('B-2: reverse sync does NOT fire when new field is explicitly provided', async () => {
    await updateAgentTool.handler(
      { agentId: 'agent-1', defaultModel: 'sonnet3.7', bedrockDefaultModel: 'opus4.8' } as any,
      context
    );

    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    // New field takes precedence; reverse sync should not overwrite it
    expect(data.bedrockDefaultModel).toBe('opus4.8');
    expect(data.defaultModel).toBe('opus4.8'); // forward sync: bedrockDefaultModel -> defaultModel
  });

  test('B-2: new field update syncs forward to legacy (existing behavior preserved)', async () => {
    await updateAgentTool.handler({ agentId: 'agent-1', bedrockDefaultModel: 'haiku4.5' } as any, context);

    const [, data] = mockUpdateCustomAgent.mock.calls[0];
    expect(data.bedrockDefaultModel).toBe('haiku4.5');
    expect(data.defaultModel).toBe('haiku4.5');
  });
});

describe('createAgentTool (parentAgentId validation)', () => {
  const baseInput = {
    name: 'New Agent',
    description: 'desc',
    defaultModel: 'sonnet4.6',
    systemPrompt: 'prompt',
    tools: [],
    useAllTools: false,
    mcpConfig: '{"mcpServers":{}}',
    runtimeType: 'agent-core',
    includeDefaultKnowledge: true,
  };

  beforeEach(() => {
    mockGetCustomAgent.mockReset();
    mockCreateCustomAgent.mockReset();
    mockDeleteCustomAgent.mockReset();
    mockSavePendingCreateAgent.mockReset();
  });

  test('triggers confirmation gate when parentAgentId is omitted (top-level creation)', async () => {
    // WHEN
    const result = await createAgentTool.handler(baseInput as any, context);

    // THEN
    expect(mockSavePendingCreateAgent).toHaveBeenCalledWith(
      'worker-1',
      expect.objectContaining({
        name: 'New Agent',
        description: 'desc',
        defaultModel: 'sonnet4.6',
        bedrockDefaultModel: 'sonnet4.6',
        systemPrompt: 'prompt',
        tools: [],
        useAllTools: false,
        mcpConfig: '{"mcpServers":{}}',
        runtimeType: 'agent-core',
        includeDefaultKnowledge: true,
      })
    );
    expect(mockCreateCustomAgent).not.toHaveBeenCalled();
    expect(result).toContain('CONFIRMATION REQUIRED');
    expect(result).toContain('confirmCreateAgent');
    expect(result).toContain('New Agent');
  });

  test('creates with parentAgentId when parent exists', async () => {
    // GIVEN
    mockGetCustomAgent.mockResolvedValue({ ...existingAgent, SK: 'parent-sk', name: 'Parent' });
    mockCreateCustomAgent.mockResolvedValue({
      ...existingAgent,
      SK: 'new-sk',
      name: 'New Agent',
      parentAgentId: 'parent-sk',
    });

    // WHEN
    const result = await createAgentTool.handler({ ...baseInput, parentAgentId: 'parent-sk' } as any, context);

    // THEN
    expect(mockGetCustomAgent).toHaveBeenCalledWith('parent-sk');
    expect(mockCreateCustomAgent).toHaveBeenCalledTimes(1);
    const [payload] = mockCreateCustomAgent.mock.calls[0];
    expect(payload.parentAgentId).toBe('parent-sk');
    expect(result).toContain('Parent Agent ID: parent-sk');
  });

  test('rejects creation when parentAgentId does not exist', async () => {
    // GIVEN
    mockGetCustomAgent.mockResolvedValue(undefined);

    // WHEN
    const result = await createAgentTool.handler({ ...baseInput, parentAgentId: 'missing-parent' } as any, context);

    // THEN
    expect(result).toMatch(/does not exist/);
    expect(result).toContain('missing-parent');
    expect(mockCreateCustomAgent).not.toHaveBeenCalled();
  });

  test('rolls back and errors when created SK accidentally matches parentAgentId', async () => {
    // GIVEN: parent lookup succeeds, but the newly generated SK happens to collide
    mockGetCustomAgent.mockResolvedValue({ ...existingAgent, SK: 'collision-sk', name: 'Parent' });
    mockCreateCustomAgent.mockResolvedValue({
      ...existingAgent,
      SK: 'collision-sk',
      name: 'New Agent',
      parentAgentId: 'collision-sk',
    });

    // WHEN
    const result = await createAgentTool.handler({ ...baseInput, parentAgentId: 'collision-sk' } as any, context);

    // THEN
    expect(result).toMatch(/cannot reference itself/);
    expect(mockDeleteCustomAgent).toHaveBeenCalledWith('collision-sk');
  });

  test('passes inferenceMode to createCustomAgent when provided (with parentAgentId)', async () => {
    mockGetCustomAgent.mockResolvedValue({ ...existingAgent, SK: 'parent-sk', name: 'Parent' });
    mockCreateCustomAgent.mockResolvedValue({
      ...existingAgent,
      SK: 'new-sk',
      name: 'New Agent',
      inferenceMode: 'kiro-cli',
      parentAgentId: 'parent-sk',
    });

    await createAgentTool.handler(
      { ...baseInput, inferenceMode: 'kiro-cli', parentAgentId: 'parent-sk' } as any,
      context
    );

    expect(mockCreateCustomAgent).toHaveBeenCalledTimes(1);
    const [payload] = mockCreateCustomAgent.mock.calls[0];
    expect(payload.inferenceMode).toBe('kiro-cli');
  });

  test('passes kiroModel to createCustomAgent when provided (with parentAgentId)', async () => {
    mockGetCustomAgent.mockResolvedValue({ ...existingAgent, SK: 'parent-sk', name: 'Parent' });
    mockCreateCustomAgent.mockResolvedValue({
      ...existingAgent,
      SK: 'new-sk',
      name: 'New Agent',
      kiroModel: 'deepseek-3.2',
      parentAgentId: 'parent-sk',
    });

    await createAgentTool.handler(
      { ...baseInput, kiroModel: 'deepseek-3.2', parentAgentId: 'parent-sk' } as any,
      context
    );

    expect(mockCreateCustomAgent).toHaveBeenCalledTimes(1);
    const [payload] = mockCreateCustomAgent.mock.calls[0];
    expect(payload.kiroModel).toBe('deepseek-3.2');
  });
});
