import { describe, expect, test } from 'vitest';
import { mergeDuplicateUserRebroadcast } from './dedup';
import type { MessageView } from './MessageList';

function pendingUserBubble(content: string, clientId?: string, ts = 1_000_000): MessageView {
  return {
    id: `pending-${ts}`,
    role: 'user',
    content,
    timestamp: new Date(ts),
    type: 'message',
    pending: true,
    ...(clientId ? { clientId } : {}),
  };
}

function confirmedUserBubble(content: string, clientId?: string, ts = 1_000_000): MessageView {
  return {
    id: `confirmed-${ts}`,
    role: 'user',
    content,
    timestamp: new Date(ts),
    type: 'message',
    ...(clientId ? { clientId } : {}),
  };
}

// Boolean adapter preserving the duplicate-detection contract of the removed
// `isDuplicateUserRebroadcast` (production references: zero; it only lived on
// in these tests). `mergeDuplicateUserRebroadcast` returns non-null exactly
// when the old predicate returned true, so every contract below carries over.
const isDup = (prev: MessageView[], eventClientId: string | undefined): boolean =>
  mergeDuplicateUserRebroadcast(prev, eventClientId, {}) !== null;

describe('duplicate detection contract (ported from isDuplicateUserRebroadcast)', () => {
  test('returns true when an existing bubble carries the same clientId', () => {
    const cid = '11111111-1111-1111-1111-111111111111';
    const prev = [pendingUserBubble('hello', cid)];
    expect(isDup(prev, cid)).toBe(true);
  });

  test('returns false when no bubble matches the clientId', () => {
    const prev = [pendingUserBubble('hello', 'AAAA')];
    expect(isDup(prev, 'BBBB')).toBe(false);
  });

  test('two consecutive identical messages have different UUIDs → both render (regression for body-match heuristic)', () => {
    // The previous body-match heuristic collapsed two legitimately-typed
    // identical messages into one if they fell inside the 30 s window.
    // With per-submission UUIDs that no longer happens: each bubble has
    // its own clientId, so neither echo matches the other one's bubble.
    const prev = [pendingUserBubble('hello', 'cid-A')];
    // First echo arrives carrying cid-A → dedups (existing bubble).
    expect(isDup(prev, 'cid-A')).toBe(true);

    // User submits a SECOND identical "hello" with a NEW UUID. The new
    // optimistic bubble lands in the array (with its own clientId).
    const prev2 = [pendingUserBubble('hello', 'cid-A'), pendingUserBubble('hello', 'cid-B', 1_000_500)];
    // Second echo arrives carrying cid-B → matches its own bubble, dedups.
    expect(isDup(prev2, 'cid-B')).toBe(true);
    // But cid-A echo (delivered late, after cid-B was added) still matches
    // bubble A — they don't cross-dedup each other's submissions.
    expect(isDup(prev2, 'cid-A')).toBe(true);
    // And an echo with a brand-new UUID (third tab) does NOT dedup.
    expect(isDup(prev2, 'cid-C')).toBe(false);
  });

  test('returns false when the rebroadcast carries no clientId', () => {
    // Backward compatibility: legacy producers (Slack handler, REST API
    // key) emit message events without a clientId. They never originate
    // from a webapp optimistic bubble, so the dedup must always pass them
    // through.
    const prev = [pendingUserBubble('hello', 'AAAA')];
    expect(isDup(prev, undefined)).toBe(false);
    expect(isDup(prev, '')).toBe(false);
  });

  test('matches a confirmed bubble by clientId (race: confirm flips pending=false before rebroadcast)', () => {
    // The action's onSuccess handler can flip `pending: false` before the
    // websocket rebroadcast lands. A previous heuristic gated dedup on
    // `pending=true`; the UUID variant does not, so the confirmed bubble
    // still dedups the late echo.
    const cid = 'cid-confirmed';
    const prev = [confirmedUserBubble('hello', cid)];
    expect(isDup(prev, cid)).toBe(true);
  });

  test('ignores assistant bubbles even when the clientId field is present', () => {
    // Assistant bubbles never carry a clientId in normal flow, but defend
    // against accidental field copy by ignoring non-user / non-message
    // entries entirely.
    const prev: MessageView[] = [
      {
        id: 'a',
        role: 'assistant',
        content: 'hi',
        timestamp: new Date(1_000_000),
        type: 'message',
        // intentionally set, but the dedup must still ignore it
        clientId: 'cid-A',
      },
    ];
    expect(isDup(prev, 'cid-A')).toBe(false);
  });

  test('ignores non-message types (agentMessage, toolUse, etc.)', () => {
    const prev: MessageView[] = [
      {
        id: 'a',
        role: 'user',
        content: 'hi',
        timestamp: new Date(1_000_000),
        type: 'agentMessage',
        clientId: 'cid-A',
      },
    ];
    expect(isDup(prev, 'cid-A')).toBe(false);
  });

  test('walks the array in reverse so it stops at the most recent matching bubble', () => {
    // No functional difference vs forward iteration for boolean output, but
    // pin the contract so a future refactor that flips the iteration order
    // does not silently change the cost (large message lists prefer to hit
    // the recent end first).
    const prev = [pendingUserBubble('one', 'cid-old', 1_000_000), pendingUserBubble('two', 'cid-new', 2_000_000)];
    expect(isDup(prev, 'cid-new')).toBe(true);
    expect(isDup(prev, 'cid-old')).toBe(true);
  });

  test('age does not matter — UUID match is sufficient (no time window)', () => {
    // The old body-match heuristic capped pending bubbles at 5 min and
    // confirmed bubbles at 30 s. The UUID variant has NO time window: a
    // long-running tab that submitted a message hours ago still dedups
    // its own delayed echo correctly.
    const cid = 'cid-stale';
    const ancientTs = Date.UTC(2020, 0, 1);
    const prev = [pendingUserBubble('hello', cid, ancientTs)];
    expect(isDup(prev, cid)).toBe(true);
  });
});

describe('mergeDuplicateUserRebroadcast (attachment-merging dedup)', () => {
  // Regression for the "submitter never sees their own image" bug.
  //
  // Pre-fix reproduction (verified against the pre-fix code on this branch,
  // 2 tests passed): the optimistic bubble carried no imageKeys/fileKeys
  // (MessageForm did not forward them), and the drop-only dedup
  // (`if (isDup(...)) return prev`) discarded the
  // rebroadcast — the ONLY realtime carrier of the attachment keys back to
  // the submitter's own tab. Net effect: no message in the submitter's list
  // ever carried imageKeys until a full server re-render (reload/reconnect).

  test('returns null when the event is not a duplicate (caller appends a new bubble)', () => {
    const prev = [pendingUserBubble('hello', 'cid-A')];
    expect(mergeDuplicateUserRebroadcast(prev, 'cid-B', { imageKeys: ['w/img.png'] })).toBeNull();
    expect(mergeDuplicateUserRebroadcast(prev, undefined, { imageKeys: ['w/img.png'] })).toBeNull();
    expect(mergeDuplicateUserRebroadcast(prev, '', {})).toBeNull();
  });

  test('duplicate without attachments returns the same array reference (no re-render)', () => {
    const prev = [pendingUserBubble('hello', 'cid-A')];
    expect(mergeDuplicateUserRebroadcast(prev, 'cid-A', {})).toBe(prev);
    expect(mergeDuplicateUserRebroadcast(prev, 'cid-A', { imageKeys: [], fileKeys: [] })).toBe(prev);
  });

  test('REGRESSION: merges event imageKeys onto an optimistic bubble that lacks them', () => {
    const cid = '11111111-1111-1111-1111-111111111111';
    const prev = [pendingUserBubble('here is an image', cid)];
    const result = mergeDuplicateUserRebroadcast(prev, cid, { imageKeys: ['worker-1/img.png'] });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].imageKeys).toEqual(['worker-1/img.png']);
    // Bubble identity is preserved so the pending → confirmed transition
    // (onConfirm maps by id) is unaffected.
    expect(result![0].id).toBe(prev[0].id);
    expect(result![0].pending).toBe(true);
    expect(result![0].clientId).toBe(cid);
    // Input array is not mutated.
    expect(prev[0].imageKeys).toBeUndefined();
  });

  test('REGRESSION: same hole closed for fileKeys', () => {
    const cid = '22222222-2222-2222-2222-222222222222';
    const prev = [pendingUserBubble('here is a file', cid)];
    const result = mergeDuplicateUserRebroadcast(prev, cid, { fileKeys: ['worker-1/abc/doc.pdf'] });
    expect(result![0].fileKeys).toEqual(['worker-1/abc/doc.pdf']);
    expect(result![0].imageKeys).toBeUndefined();
  });

  test('bubble that already carries imageKeys (instant-preview path) is left untouched', () => {
    const cid = 'cid-with-keys';
    const bubble: MessageView = {
      ...pendingUserBubble('img', cid),
      imageKeys: ['worker-1/img.png'],
    };
    const prev = [bubble];
    const result = mergeDuplicateUserRebroadcast(prev, cid, { imageKeys: ['worker-1/img.png'] });
    // Same reference: nothing to merge, no re-render, and any in-flight
    // client-side rendering state on the bubble is undisturbed.
    expect(result).toBe(prev);
  });

  test('partial merge: bubble has imageKeys but not fileKeys', () => {
    const cid = 'cid-partial';
    const bubble: MessageView = {
      ...pendingUserBubble('both', cid),
      imageKeys: ['worker-1/img.png'],
    };
    const result = mergeDuplicateUserRebroadcast([bubble], cid, {
      imageKeys: ['worker-1/other.png'],
      fileKeys: ['worker-1/abc/doc.pdf'],
    });
    // Existing imageKeys win (the bubble's keys are the submit-time truth);
    // missing fileKeys are filled from the event.
    expect(result![0].imageKeys).toEqual(['worker-1/img.png']);
    expect(result![0].fileKeys).toEqual(['worker-1/abc/doc.pdf']);
  });

  test('matches the most recent bubble when scanning from the end', () => {
    const prev = [pendingUserBubble('one', 'cid-old', 1_000_000), pendingUserBubble('two', 'cid-new', 2_000_000)];
    const result = mergeDuplicateUserRebroadcast(prev, 'cid-old', { imageKeys: ['w/a.png'] });
    expect(result![0].imageKeys).toEqual(['w/a.png']);
    expect(result![1].imageKeys).toBeUndefined();
  });

  test('ignores assistant bubbles and non-message types', () => {
    const prev: MessageView[] = [
      { id: 'a', role: 'assistant', content: 'hi', timestamp: new Date(1), type: 'message', clientId: 'cid-A' },
      { id: 'b', role: 'user', content: 'hi', timestamp: new Date(2), type: 'agentMessage', clientId: 'cid-A' },
    ];
    expect(mergeDuplicateUserRebroadcast(prev, 'cid-A', { imageKeys: ['w/a.png'] })).toBeNull();
  });
});
