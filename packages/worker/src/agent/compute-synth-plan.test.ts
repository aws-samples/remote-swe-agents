import { describe, it, expect } from 'vitest';
import { computeSynthPlan } from './compute-synth-plan';

describe('computeSynthPlan', () => {
  const makeItem = (sk: string, role: string) =>
    ({ PK: 'x', SK: sk, content: `[{"text":"msg-${sk}"}]`, role, type: role }) as any;

  it('turn 1: single user item + consumedTailCount=1 → empty itemsToSynth', () => {
    const history = [makeItem('001', 'user')];
    const { itemsToSynth, rawCount, replayTrimCount } = computeSynthPlan(history, 1);
    expect(itemsToSynth).toHaveLength(0);
    expect(rawCount).toBe(1);
    expect(replayTrimCount).toBe(1);
  });

  it('turn 2: 3 items + consumedTailCount=1 → first 2 items synthesised', () => {
    const history = [makeItem('001', 'user'), makeItem('002', 'assistant'), makeItem('003', 'user')];
    const { itemsToSynth } = computeSynthPlan(history, 1);
    expect(itemsToSynth).toHaveLength(2);
    expect(itemsToSynth[0]!.SK).toBe('001');
    expect(itemsToSynth[1]!.SK).toBe('002');
  });

  it('multi-item current turn: consumedTailCount=3 trims 3 from the tail', () => {
    const history = [
      makeItem('001', 'user'),
      makeItem('002', 'assistant'),
      makeItem('003', 'user'),
      makeItem('004', 'assistant'),
      makeItem('005', 'user'),
    ];
    const { itemsToSynth, replayTrimCount } = computeSynthPlan(history, 3);
    expect(replayTrimCount).toBe(3);
    expect(itemsToSynth).toHaveLength(2);
    expect(itemsToSynth[0]!.SK).toBe('001');
    expect(itemsToSynth[1]!.SK).toBe('002');
  });

  it('consumedTailCount=0 is clamped to 1 (always trim at least the current message)', () => {
    const history = [makeItem('001', 'user'), makeItem('002', 'assistant'), makeItem('003', 'user')];
    const { itemsToSynth, replayTrimCount } = computeSynthPlan(history, 0);
    expect(replayTrimCount).toBe(1);
    expect(itemsToSynth).toHaveLength(2);
  });

  it('consumedTailCount >= history.length → empty itemsToSynth (no items to synthesise)', () => {
    const history = [makeItem('001', 'user')];
    const { itemsToSynth } = computeSynthPlan(history, 5);
    expect(itemsToSynth).toHaveLength(0);
  });

  it('empty history → empty itemsToSynth', () => {
    const { itemsToSynth, rawCount } = computeSynthPlan([], 1);
    expect(itemsToSynth).toHaveLength(0);
    expect(rawCount).toBe(0);
  });
});
