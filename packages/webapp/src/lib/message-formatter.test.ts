import { describe, expect, test } from 'vitest';
import { renderAgentMessage, renderUserMessage } from '@remote-swe-agents/agent-core/lib';
import { extractUserMessage, stripAgentMessagePrefix, stripSenderPrefix } from './message-formatter';

/**
 * Regression guard for the agent-messaging dual storage format.
 *
 * Sibling-to-sibling agent communication is persisted twice:
 *   1. Into the TARGET agent's own history as `messageType: 'agentMessage'` wrapped with
 *      `renderAgentMessage(...)` so the recipient's LLM sees a proper `<user_message>`
 *      envelope and reply instruction.
 *   2. Into the PARENT session's history as `messageType: 'communicationLog'` with the
 *      raw message only (UI-only; LLM-filtered by default).
 *
 * The session detail page routes both shapes through the same render path:
 *   extractUserMessage(text) -> stripAgentMessagePrefix(...)
 *
 * This test locks the invariant that, given the same logical payload, both storage
 * shapes produce identical rendered output. If `renderAgentMessage`'s envelope changes,
 * or if `extractUserMessage` / `stripAgentMessagePrefix` regress, this test fails loudly
 * instead of the UI silently showing asymmetric content depending on which shape a row
 * was stored in.
 */
describe('message-formatter render parity for agentMessage vs communicationLog storage shapes', () => {
  const renderStoredRow = (text: string) => stripAgentMessagePrefix(extractUserMessage(text));

  const cases: { name: string; rawMessage: string }[] = [
    { name: 'plain one-liner', rawMessage: 'hello sibling' },
    { name: 'multi-line with markdown', rawMessage: 'report:\n- item 1\n- item 2\n\n**done**' },
    { name: 'payload with angle-bracket tokens (not matching user_message tags)', rawMessage: 'see <foo> and </bar>' },
    { name: 'empty-ish payload', rawMessage: '' },
  ];

  for (const { name, rawMessage } of cases) {
    test(`${name}: agentMessage shape and communicationLog shape render identically`, () => {
      const senderName = 'Sibling A';
      const senderSessionId = 'session-sibling-a';
      const wrappedMessage = `[Message from ${senderName} (${senderSessionId})]: ${rawMessage}`;

      // Shape 1 (agentMessage, as delivered to the target child): wrapped with
      // renderAgentMessage. This matches what agent-messaging.ts L~72 stores.
      const agentMessageStoredText = renderAgentMessage({
        message: wrappedMessage,
        senderSessionId,
      });

      // Shape 2 (communicationLog, as mirrored into the parent session): raw message.
      // This matches what agent-messaging.ts L~101 stores.
      const communicationLogStoredText = rawMessage;

      const renderedFromAgentMessage = renderStoredRow(agentMessageStoredText);
      const renderedFromCommunicationLog = renderStoredRow(communicationLogStoredText);

      expect(renderedFromAgentMessage).toBe(renderedFromCommunicationLog);
      expect(renderedFromAgentMessage).toBe(rawMessage.trim());
    });
  }
});

describe('stripSenderPrefix', () => {
  test('strips a webapp prefix with display name', () => {
    expect(stripSenderPrefix('[from: alice (webapp)]\nHi everyone')).toBe('Hi everyone');
  });

  test('strips a slack prefix with display name', () => {
    expect(stripSenderPrefix('[from: slack-bob (slack)]\nhello from slack')).toBe('hello from slack');
  });

  test('strips a prefix without a trailing newline', () => {
    expect(stripSenderPrefix('[from: x (webapp)]body-no-newline')).toBe('body-no-newline');
  });

  test('handles a long sanitised display name (clipped to 64 chars)', () => {
    const longName = 'A'.repeat(64);
    const raw = `[from: ${longName} (webapp)]\nhello`;
    expect(stripSenderPrefix(raw)).toBe('hello');
  });

  test('leaves pre-feature content without a prefix unchanged', () => {
    expect(stripSenderPrefix('legacy bubble body')).toBe('legacy bubble body');
    expect(stripSenderPrefix('multi\nline\nbody')).toBe('multi\nline\nbody');
  });

  test('is idempotent', () => {
    const raw = '[from: alice (webapp)]\nhi';
    expect(stripSenderPrefix(stripSenderPrefix(raw))).toBe('hi');
  });

  test('does NOT strip an unrelated bracketed line that only looks similar', () => {
    // A real user message starting with "[from:" but with an unknown
    // parenthesised label must pass through untouched — otherwise we could
    // corrupt a legitimate quoted email / forum post.
    expect(stripSenderPrefix('[from: someone (email)]\nbody')).toBe('[from: someone (email)]\nbody');
    expect(stripSenderPrefix('[from: no-parens]\nbody')).toBe('[from: no-parens]\nbody');
    // Prefix-like text in the middle of a message must not match.
    expect(stripSenderPrefix('prelude\n[from: x (webapp)]\ntail')).toBe('prelude\n[from: x (webapp)]\ntail');
  });

  test('composes correctly with extractUserMessage for the DDB-read path', () => {
    // Simulate the page.tsx pipeline: a `userMessage` item stores the full
    // envelope. The UI pipeline strips envelope tags first, then the
    // sender prefix. End result: just the user's body.
    const envelope = renderUserMessage({
      message: 'Hi there!',
      sender: { type: 'webapp', id: 'u', displayName: 'alice' },
    });
    const extracted = stripSenderPrefix(extractUserMessage(envelope));
    expect(extracted).toBe('Hi there!');
  });

  test('strips the apikey sender header (regression test for missing apikey in regex)', () => {
    // An early revision of the sender-attribution feature introduced the
    // `apikey` sender type for messages arriving via the REST API, but the
    // original `stripSenderPrefix` regex only matched `(slack|webapp)`.
    // Result: API key messages rendered the literal `[from: name (apikey)]`
    // line inside the bubble instead of the clean message body.
    expect(stripSenderPrefix('[from: CI deploy bot (apikey)]\nrun migration')).toBe('run migration');
    expect(stripSenderPrefix('[from: apikey-deadbeef (apikey)]\nhi')).toBe('hi');
    // Idempotent for apikey too.
    const raw = '[from: x (apikey)]\nhi';
    expect(stripSenderPrefix(stripSenderPrefix(raw))).toBe('hi');
  });

  test('composes with renderUserMessage for an apikey envelope (DDB-read parity)', () => {
    const envelope = renderUserMessage({
      message: 'deploy v2',
      sender: { type: 'apikey', id: 'apikey-1234567890ab', displayName: 'CI deploy bot' },
    });
    const extracted = stripSenderPrefix(extractUserMessage(envelope));
    expect(extracted).toBe('deploy v2');
  });
});
