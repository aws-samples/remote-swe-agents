import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';

const mockCreateCustomAgent = vi.fn();

vi.mock('../../lib/custom-agent', () => ({
  createCustomAgent: (...args: any[]) => mockCreateCustomAgent(...args),
}));

import { confirmCreateAgentTool, savePendingCreateAgent, PendingAgentData } from './index';

const mockContext = {
  workerId: 'test-worker-create-agent-123',
  toolUseId: 'test-tool-use',
  globalPreferences: { PK: 'global-config', SK: 'general' },
};

const sampleAgentData: PendingAgentData = {
  name: 'Test Agent',
  description: 'A test agent',
  defaultModel: 'sonnet4.6',
  bedrockDefaultModel: 'sonnet4.6',
  systemPrompt: 'You are a test agent.',
  tools: ['commandExecution'],
  useAllTools: false,
  mcpConfig: '{"mcpServers":{}}',
  runtimeType: 'agent-core',
  includeDefaultKnowledge: true,
};

describe('confirmCreateAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T09:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      unlinkSync(join(tmpdir(), `.pending-create-agent-${mockContext.workerId}`));
    } catch {}
  });

  test('creates agent when pending data exists', async () => {
    savePendingCreateAgent(mockContext.workerId, sampleAgentData);
    mockCreateCustomAgent.mockResolvedValue({
      SK: 'new-agent-id',
      name: 'Test Agent',
    });

    const result = await confirmCreateAgentTool.handler({}, mockContext as any);

    expect(mockCreateCustomAgent).toHaveBeenCalledWith(sampleAgentData);
    expect(result).toContain('Agent created successfully');
    expect(result).toContain('new-agent-id');
    expect(result).toContain('Test Agent');
  });

  test('returns error when no pending createAgent exists', async () => {
    const result = await confirmCreateAgentTool.handler({}, mockContext as any);

    expect(mockCreateCustomAgent).not.toHaveBeenCalled();
    expect(result).toContain('No pending createAgent');
  });

  test('pending data is consumed (cannot confirm twice)', async () => {
    savePendingCreateAgent(mockContext.workerId, sampleAgentData);
    mockCreateCustomAgent.mockResolvedValue({
      SK: 'new-agent-id',
      name: 'Test Agent',
    });

    await confirmCreateAgentTool.handler({}, mockContext as any);
    const secondResult = await confirmCreateAgentTool.handler({}, mockContext as any);

    expect(mockCreateCustomAgent).toHaveBeenCalledTimes(1);
    expect(secondResult).toContain('No pending createAgent');
  });

  test('last createAgent call wins when called multiple times before confirm', async () => {
    const firstData = { ...sampleAgentData, name: 'First Agent' };
    const secondData = { ...sampleAgentData, name: 'Second Agent' };

    savePendingCreateAgent(mockContext.workerId, firstData);
    savePendingCreateAgent(mockContext.workerId, secondData);

    mockCreateCustomAgent.mockResolvedValue({
      SK: 'second-id',
      name: 'Second Agent',
    });

    const result = await confirmCreateAgentTool.handler({}, mockContext as any);

    expect(mockCreateCustomAgent).toHaveBeenCalledWith(secondData);
    expect(result).toContain('Second Agent');
  });

  test('last-wins: first pending is overwritten and not recoverable', async () => {
    const firstData = { ...sampleAgentData, name: 'First Agent' };
    const secondData = { ...sampleAgentData, name: 'Second Agent' };

    savePendingCreateAgent(mockContext.workerId, firstData);
    savePendingCreateAgent(mockContext.workerId, secondData);

    mockCreateCustomAgent.mockResolvedValue({
      SK: 'second-id',
      name: 'Second Agent',
    });

    await confirmCreateAgentTool.handler({}, mockContext as any);
    const secondConfirm = await confirmCreateAgentTool.handler({}, mockContext as any);

    expect(mockCreateCustomAgent).toHaveBeenCalledTimes(1);
    expect(secondConfirm).toContain('No pending createAgent');
  });

  test('rejects expired pending (TTL 30 minutes)', async () => {
    savePendingCreateAgent(mockContext.workerId, sampleAgentData);

    vi.advanceTimersByTime(31 * 60 * 1000);

    const result = await confirmCreateAgentTool.handler({}, mockContext as any);

    expect(mockCreateCustomAgent).not.toHaveBeenCalled();
    expect(result).toContain('expired');
    expect(result).toContain('30 minutes');
  });
});
