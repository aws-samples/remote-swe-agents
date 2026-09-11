import { describe, expect, test } from 'vitest';
import { getEssentialSystemPrompt } from './default-agent';

describe('getEssentialSystemPrompt — runtime-aware environment description', () => {
  test('defaults to neutral description when no runtimeType provided', () => {
    const prompt = getEssentialSystemPrompt();
    expect(prompt).toContain('Runtime Environment section if available');
    expect(prompt).not.toContain('Amazon EC2 instance');
    expect(prompt).not.toContain('AgentCore');
  });

  test('shows EC2 description for ec2 runtime', () => {
    const prompt = getEssentialSystemPrompt('ec2');
    expect(prompt).toContain('Amazon EC2 instance');
    expect(prompt).toContain('IMDSv2');
    expect(prompt).not.toContain('AgentCore');
  });

  test('shows AgentCore description for agent-core runtime', () => {
    const prompt = getEssentialSystemPrompt('agent-core');
    expect(prompt).toContain('AgentCore runtime');
    expect(prompt).toContain('IMDS is NOT available');
    expect(prompt).not.toContain('Amazon EC2 instance');
  });
});

describe('getEssentialSystemPrompt — anti-duplicate wake-up guidance', () => {
  // These tests are intentionally prose-matching rather than structural. The
  // regression they guard is "LLM rehashes the previous turn's status on a
  // wake-up turn with no new information", and the only behavioural lever we
  // have (per product decision — no code-side dedup) is the system prompt.
  // If a future refactor reworks the prompt, these strings must remain
  // addressed by equivalent wording; dropping the guidance silently would
  // reintroduce the duplicate-message regression.

  const prompt = getEssentialSystemPrompt();

  test('documents the cross-turn rehash pattern as BAD', () => {
    expect(prompt).toContain('BAD (cross-turn rehash)');
    expect(prompt).toContain('#1 source of perceived "duplicate messages"');
  });

  test('has a dedicated Wake-up turns section', () => {
    expect(prompt).toContain('### Wake-up turns with no new information');
    expect(prompt).toContain('anti-duplicate rule');
  });

  test('recommends silent terminate on wake-up with no new information', () => {
    expect(prompt).toMatch(/Preferred:\s*silent terminate/);
  });

  test('recommends acknowledgeAgent over sendMessageToAgent for noted/still-working replies', () => {
    expect(prompt).toContain('prefer `acknowledgeAgent` (silent receipt)');
  });

  test('notes that user-initiated wake-ups can only be silent-terminated', () => {
    // Clarifies the scope of the acknowledgeAgent recommendation: it is for
    // parent-agent wake-ups. User-initiated wake-ups (typed directly by the
    // user in Slack / webapp) have no agent-to-agent channel to ack through,
    // so silent terminate is the only correct option.
    expect(prompt).toContain('user-initiated wake-ups');
    expect(prompt).toContain('silent terminate is the only correct option');
  });

  test('resolves the code-smell tone mismatch for wake-up silent terminate', () => {
    // The Message Sending Patterns section calls relying on orchestrator
    // suppression "a code smell" for real completions. The Wake-up section
    // carves out wake-up turns as the one legitimate case where the same
    // mechanism is the correct outcome, so the two sections do not read
    // as contradictory.
    expect(prompt).toContain('the one legitimate case');
    expect(prompt).toContain(
      '"code smell" caveat in Message Sending Patterns applies to silencing a *real* completion'
    );
  });

  test('explicitly forbids rehashing previous status', () => {
    expect(prompt).toContain('Do NOT rehash the previous status');
    expect(prompt).toContain('even if you rewrote the wording');
  });

  test('defines "new information" narrowly so still-working does not qualify', () => {
    expect(prompt).toContain('Only send a new message when you have new information');
    expect(prompt).toContain('"Still working on the same thing I reported last turn" is NOT new information');
  });

  test('addresses the "rude not to reply" instinct head-on', () => {
    expect(prompt).toContain(`feeling of "it would be rude not to reply" is a trap`);
  });
});
