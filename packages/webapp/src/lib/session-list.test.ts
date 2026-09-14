import { describe, expect, it } from 'vitest';
import type { SessionItem } from '@remote-swe-agents/agent-core/schema';
import {
  SESSION_PREVIEW_MAX_LENGTH,
  toInitialMessagePreview,
  toSessionListItem,
  toSessionListItems,
} from './session-list';

function makeSession(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    PK: 'sessions',
    SK: 'session-1',
    workerId: 'session-1',
    createdAt: 1,
    updatedAt: 1,
    LSI1: '1',
    initialMessage: 'hello',
    instanceStatus: 'running',
    sessionCost: 0,
    agentStatus: 'pending',
    ...overrides,
  };
}

describe('toSessionListItem', () => {
  it('keeps short initialMessage as-is', () => {
    const item = toSessionListItem(makeSession({ initialMessage: 'short message' }));
    expect(item.initialMessagePreview).toBe('short message');
  });

  it('truncates long initialMessage to the preview length', () => {
    const long = 'a'.repeat(10_000);
    const item = toSessionListItem(makeSession({ initialMessage: long }));
    expect(item.initialMessagePreview).toHaveLength(SESSION_PREVIEW_MAX_LENGTH);
  });

  it('extracts the user message from a wrapped prompt before truncating', () => {
    const wrapped = `<system>${'x'.repeat(5000)}</system><user_message>actual user text</user_message>`;
    const item = toSessionListItem(makeSession({ initialMessage: wrapped }));
    expect(item.initialMessagePreview).toBe('actual user text');
  });

  it('drops the raw initialMessage field from the returned item', () => {
    const item = toSessionListItem(makeSession({ initialMessage: 'b'.repeat(1000) }));
    expect('initialMessage' in item).toBe(false);
  });

  it('does not mutate the original session', () => {
    const session = makeSession({ initialMessage: 'b'.repeat(1000) });
    toSessionListItem(session);
    expect(session.initialMessage).toHaveLength(1000);
  });

  it('preserves all other fields', () => {
    const session = makeSession({ title: 'My title', sessionCost: 1.23, parentSessionId: 'p-1' });
    const item = toSessionListItem(session);
    expect(item.title).toBe('My title');
    expect(item.sessionCost).toBe(1.23);
    expect(item.parentSessionId).toBe('p-1');
  });

  it('maps arrays', () => {
    const items = toSessionListItems([makeSession(), makeSession({ SK: 'session-2', workerId: 'session-2' })]);
    expect(items).toHaveLength(2);
    expect(items[1].workerId).toBe('session-2');
  });
});

describe('toInitialMessagePreview', () => {
  it('extracts and truncates', () => {
    const wrapped = `<user_message>${'y'.repeat(500)}</user_message>`;
    expect(toInitialMessagePreview(wrapped)).toHaveLength(SESSION_PREVIEW_MAX_LENGTH);
  });
});
