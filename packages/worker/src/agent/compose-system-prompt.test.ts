import { describe, it, expect } from 'vitest';
import { composeSystemPrompt } from './compose-system-prompt';

describe('composeSystemPrompt', () => {
  it('appends environmentBlock when provided', () => {
    const result = composeSystemPrompt('base prompt', 'Context usage: 42%');
    expect(result).toBe('base prompt\n\nContext usage: 42%');
  });

  it('returns systemPrompt unchanged when environmentBlock is undefined', () => {
    const result = composeSystemPrompt('base prompt', undefined);
    expect(result).toBe('base prompt');
  });

  it('returns systemPrompt unchanged when environmentBlock is empty string', () => {
    const result = composeSystemPrompt('base prompt', '');
    expect(result).toBe('base prompt');
  });
});
