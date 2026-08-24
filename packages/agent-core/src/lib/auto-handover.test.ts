import { describe, expect, test } from 'vitest';
import { buildContextUsageEnvironmentBlock, CONTEXT_USAGE_GUIDELINE_PERCENTAGE } from './auto-handover';

describe('buildContextUsageEnvironmentBlock', () => {
  test('returns undefined when the percentage is unknown', () => {
    expect(buildContextUsageEnvironmentBlock(undefined)).toBeUndefined();
    expect(buildContextUsageEnvironmentBlock(NaN)).toBeUndefined();
    expect(buildContextUsageEnvironmentBlock(Infinity)).toBeUndefined();
  });

  test('renders rounded usage and the guideline', () => {
    const block = buildContextUsageEnvironmentBlock(42.349);
    expect(block).toContain('## Context Window Usage');
    expect(block).toContain('~42%');
    expect(block).toContain(`~${CONTEXT_USAGE_GUIDELINE_PERCENTAGE}%`);
  });

  test('is model-driven: instructs the model to hand over itself via createNewSession role=successor', () => {
    const block = buildContextUsageEnvironmentBlock(85)!;
    expect(block).toContain('createNewSession');
    expect(block).toContain('successor');
    // must NOT describe a mechanical/automatic trigger anymore
    expect(block.toLowerCase()).not.toContain('automatic handover');
  });

  test('includes soft loop guidance (do not immediately hand over again)', () => {
    const block = buildContextUsageEnvironmentBlock(85)!;
    expect(block.toLowerCase()).toContain('handover');
    expect(block).toMatch(/do not hand over immediately|prioritise making concrete progress/i);
  });

  test('clamps out-of-range values', () => {
    expect(buildContextUsageEnvironmentBlock(150)).toContain('~100%');
    expect(buildContextUsageEnvironmentBlock(-5)).toContain('~0%');
  });

  test('respects a custom guideline', () => {
    expect(buildContextUsageEnvironmentBlock(50, { guideline: 70 })).toContain('~70%');
  });
});
