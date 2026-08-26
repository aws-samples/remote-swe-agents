/**
 * Tool-interruption marker detection + synthetic terminal results.
 * Exercises the REAL production functions used by KiroAcpAgent.stream()
 * (isToolInterruptedMarker, buildInterruptedToolResults) — the same functions
 * the generator calls, so a regression in either is caught here.
 */
import { describe, it, expect } from 'vitest';
import {
  isToolInterruptedMarker,
  buildInterruptedToolResults,
  TOOL_INTERRUPTED_MARKER,
  TOOL_INTERRUPTED_SYNTH_OUTPUT,
} from './kiro-acp-agent';

describe('isToolInterruptedMarker', () => {
  it('matches the exact kiro-cli marker (trimmed)', () => {
    expect(isToolInterruptedMarker(TOOL_INTERRUPTED_MARKER)).toBe(true);
    expect(isToolInterruptedMarker(`  ${TOOL_INTERRUPTED_MARKER}\n`)).toBe(true);
  });

  it('does NOT match when the marker is only quoted inside a longer sentence (no false positive)', () => {
    expect(isToolInterruptedMarker(`The CLI said "${TOOL_INTERRUPTED_MARKER}" which means it was blocked.`)).toBe(
      false
    );
    expect(isToolInterruptedMarker('Tool uses were interrupted')).toBe(false);
    expect(isToolInterruptedMarker('')).toBe(false);
    expect(isToolInterruptedMarker('some unrelated chunk')).toBe(false);
  });
});

describe('buildInterruptedToolResults', () => {
  it('emits a failed terminal result for every in-flight tool id', () => {
    const events = buildInterruptedToolResults(['t1', 't2']);
    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.type).toBe('tool-result');
      if (ev.type === 'tool-result') {
        expect(ev.status).toBe('failed');
        expect(ev.output).toBe(TOOL_INTERRUPTED_SYNTH_OUTPUT);
      }
    }
    const ids = events.map((e) => (e.type === 'tool-result' ? e.toolCallId : '')).sort();
    expect(ids).toEqual(['t1', 't2']);
  });

  it('emits nothing when there are no in-flight tools', () => {
    expect(buildInterruptedToolResults([])).toEqual([]);
    expect(buildInterruptedToolResults(new Set<string>())).toEqual([]);
  });
});
