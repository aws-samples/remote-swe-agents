import { describe, expect, test } from 'vitest';
import { getMessageSenderKey, type MessageView } from './MessageList';

/**
 * Helpers to build a `MessageView` quickly. We only set the fields the
 * grouping logic looks at; the rest are typed as optional on `MessageView`.
 */
function userMsg(partial: Partial<MessageView>): MessageView {
  return {
    id: partial.id ?? 'm',
    role: 'user',
    content: partial.content ?? 'hi',
    timestamp: partial.timestamp ?? new Date(0),
    type: 'message',
    ...partial,
  } as MessageView;
}

function assistantMsg(partial: Partial<MessageView>): MessageView {
  return {
    id: partial.id ?? 'a',
    role: 'assistant',
    content: partial.content ?? 'ok',
    timestamp: partial.timestamp ?? new Date(0),
    type: 'message',
    ...partial,
  } as MessageView;
}

describe('getMessageSenderKey', () => {
  test('user messages from the same human (same userSenderUserId) share a key', () => {
    const a = userMsg({ id: '1', userSenderType: 'webapp', userSenderUserId: 'u-alice' });
    const b = userMsg({ id: '2', userSenderType: 'webapp', userSenderUserId: 'u-alice' });
    expect(getMessageSenderKey(a)).toBe(getMessageSenderKey(b));
  });

  test('user messages from different humans yield different keys (Alice → Bob bug)', () => {
    const alice = userMsg({ id: '1', userSenderType: 'webapp', userSenderUserId: 'u-alice' });
    const bob = userMsg({ id: '2', userSenderType: 'webapp', userSenderUserId: 'u-bob' });
    // Critical regression check: the original grouping bug merged Alice's
    // and Bob's bubbles because it only considered role + agentName.
    expect(getMessageSenderKey(alice)).not.toBe(getMessageSenderKey(bob));
  });

  test('different senderType (slack vs webapp) splits groups even when ids collide', () => {
    const slack = userMsg({ id: '1', userSenderType: 'slack', userSenderUserId: 'shared-id' });
    const webapp = userMsg({ id: '2', userSenderType: 'webapp', userSenderUserId: 'shared-id' });
    expect(getMessageSenderKey(slack)).not.toBe(getMessageSenderKey(webapp));
  });

  test('falls back to displayName when userSenderUserId is missing (legacy compat)', () => {
    const a = userMsg({ id: '1', userSenderType: 'webapp', userSenderDisplayName: 'Alice' });
    const b = userMsg({ id: '2', userSenderType: 'webapp', userSenderDisplayName: 'Alice' });
    const c = userMsg({ id: '3', userSenderType: 'webapp', userSenderDisplayName: 'Bob' });
    expect(getMessageSenderKey(a)).toBe(getMessageSenderKey(b));
    expect(getMessageSenderKey(a)).not.toBe(getMessageSenderKey(c));
  });

  test('messages with no sender metadata at all collapse onto a single legacy bucket', () => {
    const a = userMsg({ id: '1' });
    const b = userMsg({ id: '2' });
    expect(getMessageSenderKey(a)).toBe(getMessageSenderKey(b));
  });

  test('apikey senders are distinguished from webapp/slack senders', () => {
    const apikey = userMsg({ id: '1', userSenderType: 'apikey', userSenderUserId: 'apikey-abc' });
    const webapp = userMsg({ id: '2', userSenderType: 'webapp', userSenderUserId: 'apikey-abc' });
    expect(getMessageSenderKey(apikey)).not.toBe(getMessageSenderKey(webapp));
  });

  test('assistant messages key on role + agentName, ignoring user-sender fields', () => {
    const a = assistantMsg({ id: '1', agentName: 'Alpha' });
    const b = assistantMsg({ id: '2', agentName: 'Alpha' });
    const c = assistantMsg({ id: '3', agentName: 'Beta' });
    expect(getMessageSenderKey(a)).toBe(getMessageSenderKey(b));
    expect(getMessageSenderKey(a)).not.toBe(getMessageSenderKey(c));
  });
});
