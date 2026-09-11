import { describe, it, expect } from 'vitest';
import { buildKiroAcpArgs } from './kiro-acp-transport';

describe('buildKiroAcpArgs', () => {
  it('always produces v3 engine args', () => {
    const args = buildKiroAcpArgs({});
    expect(args).toEqual(['acp', '--agent-engine', 'v3']);
  });

  it('does not include --model, --trust-all-tools, or --agent (v3 rejects them)', () => {
    const args = buildKiroAcpArgs({ model: 'claude-sonnet-4.5', trustAllTools: true, agentName: 'foo' });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--trust-all-tools');
    expect(args).not.toContain('--agent');
  });
});
