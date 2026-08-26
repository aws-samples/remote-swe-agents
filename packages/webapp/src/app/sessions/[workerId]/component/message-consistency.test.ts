import { describe, expect, test } from 'vitest';
import { isPreviewRendered } from './message-consistency';
import type { MessageView } from './MessageList';

function bubble(content: string, id = 'x', type: MessageView['type'] = 'message'): MessageView {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: new Date(0),
    type,
  };
}

describe('isPreviewRendered', () => {
  test('empty preview is treated as rendered (nothing to recover)', () => {
    expect(isPreviewRendered([], '')).toBe(true);
    expect(isPreviewRendered([bubble('hello')], '   ')).toBe(true);
  });

  test('exact match of a short message is detected', () => {
    const msgs = [bubble('done')];
    expect(isPreviewRendered(msgs, 'done')).toBe(true);
  });

  test('preview is a 500-char truncation of a longer bubble: prefix still matches', () => {
    const full = 'A'.repeat(800);
    const preview = full.slice(0, 500);
    expect(isPreviewRendered([bubble(full)], preview)).toBe(true);
  });

  test('missing bubble returns false (drawing event dropped)', () => {
    const msgs = [bubble('an earlier message'), bubble('another one')];
    expect(isPreviewRendered(msgs, 'the brand new reply that never rendered')).toBe(false);
  });

  test('whitespace differences do not defeat the match', () => {
    const msgs = [bubble('Here   is\n\n a   reply')];
    expect(isPreviewRendered(msgs, 'Here is a reply')).toBe(true);
  });

  test('a leading URL (re-spaced by formatMessage on both sides) still matches within prefix', () => {
    const text = 'https://example.com/path is the link';
    expect(isPreviewRendered([bubble(text)], text)).toBe(true);
  });

  test('different first-40-chars means no false-positive match', () => {
    const msgs = [bubble('completely different content over forty characters long here')];
    expect(isPreviewRendered(msgs, 'the previewed message that is not present at all here')).toBe(false);
  });

  test('ignores empty-content bubbles', () => {
    const msgs = [bubble(''), bubble('   ')];
    expect(isPreviewRendered(msgs, 'a real preview')).toBe(false);
  });

  // --- W3 regression: short bubbles must not wildcard-match a longer preview ---

  test('a short bubble sharing the opening does NOT match a long preview', () => {
    // "Deploying" is a legit short status bubble; the dropped message happens
    // to start the same way but is much longer. Must be detected as missing.
    const msgs = [bubble('Deploying')];
    const preview = 'Deploying the new consistency-recovery fix now, this will take a moment';
    expect(isPreviewRendered(msgs, preview)).toBe(false);
  });

  test('a short bubble equal to a short preview still matches (length >= n holds)', () => {
    const msgs = [bubble('Deploying')];
    expect(isPreviewRendered(msgs, 'Deploying')).toBe(true);
  });

  test('toolUse bubbles are excluded from matching (their content is the tool name)', () => {
    // A generic tool-use bubble renders `content = toolName`. It must never
    // satisfy a preview match, even if the preview begins with that name.
    const msgs = [bubble('executeCommand', 'tool-1', 'toolUse')];
    expect(isPreviewRendered(msgs, 'executeCommand ran and produced this long output preview text here')).toBe(false);
  });

  test('a real message bubble after a decoy toolUse bubble is still found', () => {
    const preview = 'The actual assistant reply that should be matched correctly';
    const msgs = [bubble('executeCommand', 'tool-1', 'toolUse'), bubble(preview, 'm-1', 'message')];
    expect(isPreviewRendered(msgs, preview)).toBe(true);
  });
});
