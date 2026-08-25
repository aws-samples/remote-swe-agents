import { describe, expect, it } from 'vitest';
import {
  extractSnippet,
  extractTextFromContent,
  MSG_TOOLS,
  SEARCHABLE_MESSAGE_TYPES,
  sortAndTruncate,
} from '@remote-swe-agents/agent-core/lib';

describe('extractSnippet (search-content-lib)', () => {
  it('returns null when no match', () => {
    expect(extractSnippet('Hello world', 'xyz')).toBeNull();
  });

  it('matches case-insensitively', () => {
    const result = extractSnippet('Hello World', 'hello');
    expect(result).not.toBeNull();
    expect(result!.matchOffset).toBe(0);
  });

  it('returns full text when short', () => {
    const result = extractSnippet('Hello World', 'World');
    expect(result).not.toBeNull();
    expect(result!.snippet).toBe('Hello World');
    expect(result!.matchOffset).toBe(6);
  });

  it('truncates long text with leading ellipsis when match is far from start', () => {
    const longText = 'A'.repeat(100) + 'MATCH' + 'B'.repeat(100);
    const result = extractSnippet(longText, 'MATCH');
    expect(result).not.toBeNull();
    expect(result!.snippet.startsWith('…')).toBe(true);
    expect(result!.snippet.endsWith('…')).toBe(true);
    const matchInSnippet = result!.snippet.toLowerCase().indexOf('match');
    expect(matchInSnippet).toBe(result!.matchOffset);
  });

  it('no leading ellipsis when match is near start', () => {
    const text = 'MATCH' + 'B'.repeat(200);
    const result = extractSnippet(text, 'MATCH');
    expect(result).not.toBeNull();
    expect(result!.snippet.startsWith('…')).toBe(false);
    expect(result!.snippet.endsWith('…')).toBe(true);
    expect(result!.matchOffset).toBe(0);
  });

  it('no trailing ellipsis when match is near end', () => {
    const text = 'A'.repeat(200) + 'MATCH';
    const result = extractSnippet(text, 'MATCH');
    expect(result).not.toBeNull();
    expect(result!.snippet.startsWith('…')).toBe(true);
    expect(result!.snippet.endsWith('…')).toBe(false);
  });

  it('respects custom snippetRadius', () => {
    const text = 'A'.repeat(50) + 'MATCH' + 'B'.repeat(50);
    const result = extractSnippet(text, 'MATCH', 10);
    expect(result).not.toBeNull();
    expect(result!.snippet.length).toBeLessThan(text.length);
    expect(result!.snippet).toContain('MATCH');
  });

  it('handles query at the very beginning', () => {
    const result = extractSnippet('QUERY rest of text', 'QUERY');
    expect(result).not.toBeNull();
    expect(result!.matchOffset).toBe(0);
    expect(result!.snippet.startsWith('…')).toBe(false);
  });

  it('handles query at the very end', () => {
    const text = 'some text QUERY';
    const result = extractSnippet(text, 'QUERY');
    expect(result).not.toBeNull();
    expect(result!.snippet.endsWith('…')).toBe(false);
  });
});

describe('SEARCHABLE_MESSAGE_TYPES (search-content-lib)', () => {
  it('includes all user-visible message types', () => {
    expect(SEARCHABLE_MESSAGE_TYPES.has('userMessage')).toBe(true);
    expect(SEARCHABLE_MESSAGE_TYPES.has('assistant')).toBe(true);
    expect(SEARCHABLE_MESSAGE_TYPES.has('toolUse')).toBe(true);
    expect(SEARCHABLE_MESSAGE_TYPES.has('agentMessage')).toBe(true);
    expect(SEARCHABLE_MESSAGE_TYPES.has('eventTrigger')).toBe(true);
  });

  it('includes communicationLog (W7: visible in UI = searchable)', () => {
    expect(SEARCHABLE_MESSAGE_TYPES.has('communicationLog')).toBe(true);
  });

  it('excludes non-visible types', () => {
    expect(SEARCHABLE_MESSAGE_TYPES.has('toolResult')).toBe(false);
    expect(SEARCHABLE_MESSAGE_TYPES.has('system')).toBe(false);
  });

  it('has exactly 6 searchable types', () => {
    expect(SEARCHABLE_MESSAGE_TYPES.size).toBe(6);
  });
});

describe('sortAndTruncate (search-content-lib)', () => {
  it('sorts results by timestamp descending (newest first)', () => {
    const results = [
      { timestamp: 100, text: 'old' },
      { timestamp: 300, text: 'newest' },
      { timestamp: 200, text: 'middle' },
    ];
    const sorted = sortAndTruncate(results, 50);
    expect(sorted[0].timestamp).toBe(300);
    expect(sorted[1].timestamp).toBe(200);
    expect(sorted[2].timestamp).toBe(100);
  });

  it('truncates to maxResults after sorting, keeping newest', () => {
    const results = Array.from({ length: 100 }, (_, i) => ({
      timestamp: i,
      text: `msg-${i}`,
    }));
    const sorted = sortAndTruncate(results, 50);
    expect(sorted).toHaveLength(50);
    expect(sorted[0].timestamp).toBe(99);
    expect(sorted[49].timestamp).toBe(50);
  });

  it('handles empty results', () => {
    expect(sortAndTruncate([], 50)).toHaveLength(0);
  });

  it('does not mutate the original array', () => {
    const results = [{ timestamp: 3 }, { timestamp: 1 }, { timestamp: 2 }];
    const original = [...results];
    sortAndTruncate(results, 50);
    expect(results).toEqual(original);
  });

  it('returns all results when fewer than maxResults', () => {
    const results = [{ timestamp: 1 }, { timestamp: 2 }];
    const sorted = sortAndTruncate(results, 50);
    expect(sorted).toHaveLength(2);
  });
});

describe('MSG_TOOLS (search-content-lib)', () => {
  it('includes user-visible message-sending tools', () => {
    expect(MSG_TOOLS.has('sendMessageToUser')).toBe(true);
    expect(MSG_TOOLS.has('sendMessageToUserIfNecessary')).toBe(true);
    expect(MSG_TOOLS.has('sendFileToUser')).toBe(true);
  });

  it('excludes agent-to-agent tools', () => {
    expect(MSG_TOOLS.has('sendMessageToAgent')).toBe(false);
    expect(MSG_TOOLS.has('acknowledgeAgent')).toBe(false);
  });
});

describe('extractTextFromContent (search-content-lib)', () => {
  it('extracts message from sendMessageToUser toolUse blocks', () => {
    const content = [{ toolUse: { name: 'sendMessageToUser', input: { message: 'Hello user' } } }];
    expect(extractTextFromContent(content, 'toolUse')).toBe('Hello user');
  });

  it('ignores non-MSG_TOOLS in toolUse messageType', () => {
    const content = [
      { toolUse: { name: 'sendMessageToAgent', input: { message: 'secret internal' } } },
      { toolUse: { name: 'executeCommand', input: { command: 'ls' } } },
    ];
    expect(extractTextFromContent(content, 'toolUse')).toBe('');
  });

  it('extracts text blocks for non-toolUse messageType', () => {
    const content = [{ text: 'Hello' }, { text: ' World' }];
    expect(extractTextFromContent(content, 'assistant')).toBe('Hello  World');
  });

  it('extracts toolUse.input.message from non-toolUse messageType (fallback)', () => {
    const content = [{ toolUse: { input: { message: 'tool msg' } } }];
    expect(extractTextFromContent(content, 'userMessage')).toBe('tool msg');
  });

  it('handles mixed content blocks', () => {
    const content = [{ text: 'First' }, { image: { source: {} } }, { text: 'Second' }];
    expect(extractTextFromContent(content, 'assistant')).toBe('First Second');
  });

  it('handles empty content array', () => {
    expect(extractTextFromContent([], 'assistant')).toBe('');
  });
});
