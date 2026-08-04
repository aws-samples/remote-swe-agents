import { describe, it, expect } from 'vitest';
import { applyRewindFilter, countRewoundMessages, RewindState } from './rewind-filter';
import { MessageItem } from '../schema';

const messageSKFromTimestamp = (timestampMs: number): string => String(timestampMs).padStart(15, '0');

const makeItem = (sk: string, messageType = 'userMessage'): MessageItem => ({
  PK: 'message-test-worker',
  SK: sk,
  content: '[]',
  role: 'user',
  tokenCount: 10,
  messageType,
});

describe('applyRewindFilter', () => {
  it('returns all items when rewindState is undefined', () => {
    const items = [makeItem('000001000000000'), makeItem('000001000001000'), makeItem('000001000002000')];
    expect(applyRewindFilter(items, undefined)).toEqual(items);
  });

  it('hides messages between cutoffSK and rewindedAt', () => {
    const items = [
      makeItem('000001000000000'), // visible: before cutoff
      makeItem('000001000001000'), // cutoff point (visible: <= cutoffSK)
      makeItem('000001000002000'), // hidden: after cutoff, before rewindedAt
      makeItem('000001000003000'), // hidden: after cutoff, before rewindedAt
      makeItem('000001000005000'), // visible: after rewindedAt
    ];

    const rewindState: RewindState = {
      cutoffSK: '000001000001000',
      rewindedAt: 1000005000, // corresponds to SK '000001000005000'
    };

    const result = applyRewindFilter(items, rewindState);
    expect(result).toHaveLength(3);
    expect(result[0].SK).toBe('000001000000000');
    expect(result[1].SK).toBe('000001000001000');
    expect(result[2].SK).toBe('000001000005000');
  });

  it('new messages after rewind are visible', () => {
    // Simulate: rewind to msg2, then user sends a new message (msg5)
    const rewindedAt = 1000004000;
    const items = [
      makeItem('000001000000000'), // visible
      makeItem('000001000001000'), // cutoff - visible
      makeItem('000001000002000'), // hidden (between cutoff and rewindedAt)
      makeItem('000001000003000'), // hidden (between cutoff and rewindedAt)
      makeItem(messageSKFromTimestamp(rewindedAt + 1000)), // new msg after rewind - visible
    ];

    const rewindState: RewindState = {
      cutoffSK: '000001000001000',
      rewindedAt,
    };

    const result = applyRewindFilter(items, rewindState);
    expect(result).toHaveLength(3);
    expect(result[2].SK).toBe(messageSKFromTimestamp(rewindedAt + 1000));
  });

  it('undo (clearing rewindState) restores all messages', () => {
    const items = [
      makeItem('000001000000000'),
      makeItem('000001000001000'),
      makeItem('000001000002000'),
      makeItem('000001000003000'),
    ];

    const rewindState: RewindState = {
      cutoffSK: '000001000001000',
      rewindedAt: 1000004000,
    };

    const filtered = applyRewindFilter(items, rewindState);
    expect(filtered).toHaveLength(2);

    // Undo: pass undefined
    const restored = applyRewindFilter(items, undefined);
    expect(restored).toEqual(items);
  });

  it('works with exact cutoff boundary (cutoff SK itself is included)', () => {
    const items = [makeItem('000001000001000'), makeItem('000001000002000')];

    const rewindState: RewindState = {
      cutoffSK: '000001000001000',
      rewindedAt: 1000003000,
    };

    const result = applyRewindFilter(items, rewindState);
    expect(result).toHaveLength(1);
    expect(result[0].SK).toBe('000001000001000');
  });

  it('handles empty items array', () => {
    const rewindState: RewindState = {
      cutoffSK: '000001000001000',
      rewindedAt: 1000003000,
    };
    expect(applyRewindFilter([], rewindState)).toEqual([]);
  });

  it('works correctly when all messages are before cutoff', () => {
    const items = [makeItem('000001000000000'), makeItem('000001000001000')];

    const rewindState: RewindState = {
      cutoffSK: '000001000005000',
      rewindedAt: 1000006000,
    };

    const result = applyRewindFilter(items, rewindState);
    expect(result).toEqual(items);
  });
});

describe('countRewoundMessages', () => {
  it('returns 0 when rewindState is undefined', () => {
    const items = [makeItem('000001000000000'), makeItem('000001000001000')];
    expect(countRewoundMessages(items, undefined)).toBe(0);
  });

  it('counts hidden messages correctly', () => {
    const items = [
      makeItem('000001000000000'),
      makeItem('000001000001000'),
      makeItem('000001000002000'),
      makeItem('000001000003000'),
      makeItem('000001000005000'),
    ];

    const rewindState: RewindState = {
      cutoffSK: '000001000001000',
      rewindedAt: 1000005000,
    };

    expect(countRewoundMessages(items, rewindState)).toBe(2);
  });
});

describe('applyRewindFilter + middleOut interaction', () => {
  it('rewind-then-middleOut produces correct context (no hidden messages leak)', () => {
    const items: MessageItem[] = [];
    for (let i = 0; i < 10; i++) {
      items.push({ ...makeItem(messageSKFromTimestamp(1000000000 + i * 1000)), tokenCount: 100 });
    }
    for (let i = 10; i < 15; i++) {
      items.push({ ...makeItem(messageSKFromTimestamp(1000000000 + i * 1000)), tokenCount: 100 });
    }
    for (let i = 15; i < 20; i++) {
      items.push({ ...makeItem(messageSKFromTimestamp(1000000000 + i * 1000)), tokenCount: 100 });
    }

    const rewindState: RewindState = {
      cutoffSK: messageSKFromTimestamp(1000009000),
      rewindedAt: 1000015000,
    };

    const filtered = applyRewindFilter(items, rewindState);
    expect(filtered).toHaveLength(15);

    const hiddenSKs = items
      .filter((item) => item.SK > rewindState.cutoffSK && item.SK < messageSKFromTimestamp(rewindState.rewindedAt))
      .map((item) => item.SK);
    for (const sk of hiddenSKs) {
      expect(filtered.find((item) => item.SK === sk)).toBeUndefined();
    }
  });

  it('toolUse-toolResult pairs remain intact after rewind filter', () => {
    const toolUseSK = messageSKFromTimestamp(1000005000);
    const toolResultSK = messageSKFromTimestamp(1000005001);
    const items = [
      makeItem(messageSKFromTimestamp(1000001000), 'userMessage'),
      makeItem(toolUseSK, 'toolUse'),
      makeItem(toolResultSK, 'toolResult'),
      makeItem(messageSKFromTimestamp(1000006000), 'assistant'),
      makeItem(messageSKFromTimestamp(1000007000), 'userMessage'),
    ];

    const rewindState: RewindState = {
      cutoffSK: toolResultSK, // cutoff includes the toolResult
      rewindedAt: 1000010000,
    };

    const result = applyRewindFilter(items, rewindState);
    expect(result).toHaveLength(3); // userMessage, toolUse, toolResult
    expect(result.find((i) => i.messageType === 'toolUse')).toBeDefined();
    expect(result.find((i) => i.messageType === 'toolResult')).toBeDefined();
  });
});

describe('applyRewindFilter - toolUse cutoff snap-forward (Critical fix)', () => {
  it('snaps cutoff forward when cutoffSK is a toolUse item', () => {
    // When user clicks "revert to here" on a sendMessageToUser (rendered from
    // a toolUse item), the cutoffSK is the toolUse SK. The toolResult at SK+1
    // must also be included to prevent orphan toolUse → Bedrock 400.
    const toolUseSK = messageSKFromTimestamp(1000005000);
    const toolResultSK = messageSKFromTimestamp(1000005001);
    const items = [
      makeItem(messageSKFromTimestamp(1000001000), 'userMessage'),
      makeItem(messageSKFromTimestamp(1000003000), 'assistant'),
      makeItem(toolUseSK, 'toolUse'),
      makeItem(toolResultSK, 'toolResult'),
      makeItem(messageSKFromTimestamp(1000006000), 'assistant'), // hidden
      makeItem(messageSKFromTimestamp(1000007000), 'userMessage'), // hidden
    ];

    const rewindState: RewindState = {
      cutoffSK: toolUseSK, // cutoff on the toolUse item itself
      rewindedAt: 1000010000,
    };

    const result = applyRewindFilter(items, rewindState);
    // Should include: userMessage, assistant, toolUse, AND toolResult (snapped forward)
    expect(result).toHaveLength(4);
    expect(result.find((i) => i.messageType === 'toolUse')).toBeDefined();
    expect(result.find((i) => i.messageType === 'toolResult')).toBeDefined();
    // The toolResult should be included despite its SK > original cutoffSK
    expect(result.find((i) => i.SK === toolResultSK)).toBeDefined();
  });

  it('does NOT snap forward when cutoffSK is not a toolUse item', () => {
    const items = [
      makeItem(messageSKFromTimestamp(1000001000), 'userMessage'),
      makeItem(messageSKFromTimestamp(1000003000), 'assistant'),
      makeItem(messageSKFromTimestamp(1000005000), 'userMessage'),
      makeItem(messageSKFromTimestamp(1000006000), 'assistant'),
    ];

    const rewindState: RewindState = {
      cutoffSK: messageSKFromTimestamp(1000003000), // regular assistant message
      rewindedAt: 1000010000,
    };

    const result = applyRewindFilter(items, rewindState);
    expect(result).toHaveLength(2);
    expect(result[0].SK).toBe(messageSKFromTimestamp(1000001000));
    expect(result[1].SK).toBe(messageSKFromTimestamp(1000003000));
  });

  it('countRewoundMessages accounts for snap-forward', () => {
    const toolUseSK = messageSKFromTimestamp(1000005000);
    const toolResultSK = messageSKFromTimestamp(1000005001);
    const items = [
      makeItem(messageSKFromTimestamp(1000001000), 'userMessage'),
      makeItem(toolUseSK, 'toolUse'),
      makeItem(toolResultSK, 'toolResult'),
      makeItem(messageSKFromTimestamp(1000006000), 'assistant'),
      makeItem(messageSKFromTimestamp(1000007000), 'userMessage'),
    ];

    const rewindState: RewindState = {
      cutoffSK: toolUseSK, // toolUse as cutoff
      rewindedAt: 1000010000,
    };

    // After snap-forward, effective cutoff is toolResultSK
    // Hidden: assistant(1000006000), userMessage(1000007000) = 2
    expect(countRewoundMessages(items, rewindState)).toBe(2);
  });
});

describe('applyRewindFilter - post-filter orphan toolUse removal (defense net)', () => {
  it('removes orphan toolUse at the end of filtered results', () => {
    // Edge case: cutoff lands between toolUse and toolResult due to unusual SK
    // patterns (e.g. toolResult has SK far from toolUse, not SK+1)
    const toolUseSK = messageSKFromTimestamp(1000005000);
    const toolResultSK = messageSKFromTimestamp(1000008000); // far away, not SK+1
    const items = [
      makeItem(messageSKFromTimestamp(1000001000), 'userMessage'),
      makeItem(toolUseSK, 'toolUse'),
      makeItem(toolResultSK, 'toolResult'), // will be hidden
      makeItem(messageSKFromTimestamp(1000009000), 'assistant'), // hidden
    ];

    const rewindState: RewindState = {
      cutoffSK: messageSKFromTimestamp(1000006000), // between toolUse and toolResult
      rewindedAt: 1000020000,
    };

    const result = applyRewindFilter(items, rewindState);
    // toolUse should be REMOVED by post-filter defense since its toolResult is hidden
    expect(result.find((i) => i.messageType === 'toolUse')).toBeUndefined();
    expect(result).toHaveLength(1);
    expect(result[0].SK).toBe(messageSKFromTimestamp(1000001000));
  });

  it('keeps toolUse when its toolResult is still present after filter', () => {
    const toolUseSK = messageSKFromTimestamp(1000005000);
    const toolResultSK = messageSKFromTimestamp(1000005001);
    const items = [
      makeItem(messageSKFromTimestamp(1000001000), 'userMessage'),
      makeItem(toolUseSK, 'toolUse'),
      makeItem(toolResultSK, 'toolResult'),
      makeItem(messageSKFromTimestamp(1000006000), 'assistant'),
    ];

    const rewindState: RewindState = {
      cutoffSK: messageSKFromTimestamp(1000006000),
      rewindedAt: 1000010000,
    };

    const result = applyRewindFilter(items, rewindState);
    expect(result).toHaveLength(4);
    expect(result.find((i) => i.messageType === 'toolUse')).toBeDefined();
    expect(result.find((i) => i.messageType === 'toolResult')).toBeDefined();
  });
});
