import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
}));

import { updateCustomAgent } from './custom-agent';

describe('updateCustomAgent (partial update)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({
      Attributes: {
        PK: 'custom-agent',
        SK: 'agent-1',
        name: 'Existing Name',
        description: 'Existing Description',
        defaultModel: 'sonnet4.6',
        systemPrompt: 'Existing system prompt',
        tools: ['existingTool'],
        useAllTools: false,
        mcpConfig: '{"mcpServers":{}}',
        runtimeType: 'agent-core',
        includeDefaultKnowledge: true,
        createdAt: 1,
        updatedAt: 2,
      },
    });
  });

  test('updates only provided fields and always sets updatedAt', async () => {
    // GIVEN
    const updates = { description: 'New description' };

    // WHEN
    await updateCustomAgent('agent-1', updates);

    // THEN
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    const input = command.input;

    expect(input.TableName).toBe('TestTable');
    expect(input.Key).toEqual({ PK: 'custom-agent', SK: 'agent-1' });

    // Only description and updatedAt should be in UpdateExpression
    expect(input.UpdateExpression).toContain('#description = :description');
    expect(input.UpdateExpression).toContain('#updatedAt = :updatedAt');
    expect(input.UpdateExpression).not.toContain('#name');
    expect(input.UpdateExpression).not.toContain('#systemPrompt');
    expect(input.UpdateExpression).not.toContain('#tools');
    expect(input.UpdateExpression).not.toContain('#mcpConfig');

    expect(input.ExpressionAttributeValues[':description']).toBe('New description');
    expect(typeof input.ExpressionAttributeValues[':updatedAt']).toBe('number');
  });

  test('skips undefined fields in the updates object', async () => {
    // GIVEN
    const updates = {
      name: 'New Name',
      description: undefined,
      tools: undefined,
    } as const;

    // WHEN
    await updateCustomAgent('agent-1', updates);

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain('#name = :name');
    expect(input.UpdateExpression).not.toContain('#description');
    expect(input.UpdateExpression).not.toContain('#tools');
    expect(input.ExpressionAttributeValues[':name']).toBe('New Name');
    expect(input.ExpressionAttributeValues[':description']).toBeUndefined();
  });

  test('allows explicit empty array to overwrite tools', async () => {
    // GIVEN
    const updates = { tools: [] };

    // WHEN
    await updateCustomAgent('agent-1', updates);

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain('#tools = :tools');
    expect(input.ExpressionAttributeValues[':tools']).toEqual([]);
  });

  test('allows explicit empty string to overwrite description', async () => {
    // GIVEN
    const updates = { description: '' };

    // WHEN
    await updateCustomAgent('agent-1', updates);

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain('#description = :description');
    expect(input.ExpressionAttributeValues[':description']).toBe('');
  });

  test('does not validate mcpConfig when it is not provided', async () => {
    // GIVEN
    const updates = { name: 'Just a name change' };

    // WHEN / THEN - no throw even though no mcpConfig
    await expect(updateCustomAgent('agent-1', updates)).resolves.toBeDefined();
  });

  test('validates mcpConfig when explicitly provided', async () => {
    // GIVEN
    const updates = { mcpConfig: 'not valid json' };

    // WHEN / THEN
    await expect(updateCustomAgent('agent-1', updates)).rejects.toThrow(/Invalid mcpConfig/);
  });

  test('does not send the update to DynamoDB when mcpConfig validation fails', async () => {
    // GIVEN
    const updates = { mcpConfig: 'not valid json' };

    // WHEN
    await expect(updateCustomAgent('agent-1', updates)).rejects.toThrow();

    // THEN
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('rejects empty string for mcpConfig (regression: previously silently defaulted)', async () => {
    // GIVEN
    const updates = { mcpConfig: '' };

    // WHEN / THEN
    await expect(updateCustomAgent('agent-1', updates)).rejects.toThrow(/Invalid mcpConfig/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('updates runtimeType only', async () => {
    // WHEN
    await updateCustomAgent('agent-1', { runtimeType: 'ec2' });

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain('#runtimeType = :runtimeType');
    expect(input.UpdateExpression).not.toContain('#name');
    expect(input.ExpressionAttributeValues[':runtimeType']).toBe('ec2');
  });

  test('allows explicit useAllTools: false to overwrite a true value', async () => {
    // WHEN
    await updateCustomAgent('agent-1', { useAllTools: false });

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain('#useAllTools = :useAllTools');
    expect(input.ExpressionAttributeValues[':useAllTools']).toBe(false);
  });

  test('allows explicit includeDefaultKnowledge: false to overwrite a true value', async () => {
    // WHEN
    await updateCustomAgent('agent-1', { includeDefaultKnowledge: false });

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain('#includeDefaultKnowledge = :includeDefaultKnowledge');
    expect(input.ExpressionAttributeValues[':includeDefaultKnowledge']).toBe(false);
  });

  test('accepts valid mcpConfig and includes it in update', async () => {
    // GIVEN
    const updates = { mcpConfig: JSON.stringify({ mcpServers: {} }) };

    // WHEN
    await updateCustomAgent('agent-1', updates);

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain('#mcpConfig = :mcpConfig');
    expect(input.ExpressionAttributeValues[':mcpConfig']).toBe('{"mcpServers":{}}');
  });

  test('empty updates object still bumps updatedAt', async () => {
    // GIVEN
    const updates = {};

    // WHEN
    await updateCustomAgent('agent-1', updates);

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toBe('SET #updatedAt = :updatedAt');
    expect(typeof input.ExpressionAttributeValues[':updatedAt']).toBe('number');
  });

  test('returns the updated attributes from DynamoDB', async () => {
    // WHEN
    const result = await updateCustomAgent('agent-1', { description: 'x' });

    // THEN
    expect(result.SK).toBe('agent-1');
    expect(result.name).toBe('Existing Name');
  });

  test('inferenceMode: null REMOVEs the attribute (reset to inherit)', async () => {
    // WHEN
    await updateCustomAgent('agent-1', { inferenceMode: null, description: 'New description' });

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).toContain('REMOVE #inferenceMode');
    expect(input.UpdateExpression).not.toContain('#inferenceMode = :inferenceMode');
    expect(input.ExpressionAttributeNames['#inferenceMode']).toBe('inferenceMode');
    expect(input.ExpressionAttributeValues[':inferenceMode']).toBeUndefined();
    // SET clause still applies for the other fields
    expect(input.UpdateExpression).toContain('#description = :description');
    expect(input.UpdateExpression).toContain('#updatedAt = :updatedAt');
  });

  test('inferenceMode: non-null value is SET, not removed', async () => {
    // WHEN
    await updateCustomAgent('agent-1', { inferenceMode: 'kiro-cli' });

    // THEN
    const input = mockSend.mock.calls[0][0].input;
    expect(input.UpdateExpression).not.toContain('REMOVE');
    expect(input.UpdateExpression).toContain('#inferenceMode = :inferenceMode');
    expect(input.ExpressionAttributeValues[':inferenceMode']).toBe('kiro-cli');
  });
});
