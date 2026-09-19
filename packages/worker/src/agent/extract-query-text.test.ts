import { describe, expect, it } from 'vitest';
import { extractQueryTextFromHistory } from './orchestrator';
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';

/**
 * These tests execute the real exported `extractQueryTextFromHistory` — the
 * function that produces the query string fed to lesson semantic retrieval in
 * buildSystemPrompt. They guard the parsing contract: it must extract the most
 * recent USER message's text (concatenating Bedrock text ContentBlocks) and
 * never throw on malformed / non-user / empty input.
 */

const userMsg = (content: string, sk = '1'): MessageItem =>
  ({
    PK: 'w1',
    SK: sk,
    role: 'user',
    content,
    messageType: 'userMessage',
    tokenCount: 0,
  }) as unknown as MessageItem;

const assistantMsg = (content: string, sk = '2'): MessageItem =>
  ({
    PK: 'w1',
    SK: sk,
    role: 'assistant',
    content,
    messageType: 'assistantMessage',
    tokenCount: 0,
  }) as unknown as MessageItem;

describe('extractQueryTextFromHistory', () => {
  it('returns empty string for empty history', () => {
    expect(extractQueryTextFromHistory([])).toBe('');
  });

  it('extracts text from a JSON ContentBlock array', () => {
    const history = [userMsg(JSON.stringify([{ text: 'deploy the stack' }]))];
    expect(extractQueryTextFromHistory(history)).toBe('deploy the stack');
  });

  it('concatenates multiple text blocks and ignores non-text blocks', () => {
    const history = [userMsg(JSON.stringify([{ text: 'first' }, { image: { format: 'png' } }, { text: 'second' }]))];
    expect(extractQueryTextFromHistory(history)).toBe('first\nsecond');
  });

  it('uses the LAST user message, not an earlier one', () => {
    const history = [
      userMsg(JSON.stringify([{ text: 'old question' }]), '1'),
      assistantMsg(JSON.stringify([{ text: 'an answer' }]), '2'),
      userMsg(JSON.stringify([{ text: 'new question' }]), '3'),
    ];
    expect(extractQueryTextFromHistory(history)).toBe('new question');
  });

  it('ignores assistant messages entirely (only user messages are queried)', () => {
    const history = [
      userMsg(JSON.stringify([{ text: 'the question' }]), '1'),
      assistantMsg(JSON.stringify([{ text: 'the assistant reply' }]), '2'),
    ];
    expect(extractQueryTextFromHistory(history)).toBe('the question');
  });

  it('falls back to the raw string when content is not JSON', () => {
    const history = [userMsg('plain non-json text')];
    expect(extractQueryTextFromHistory(history)).toBe('plain non-json text');
  });

  it('returns empty string when the last user message has no content', () => {
    const history = [userMsg('')];
    expect(extractQueryTextFromHistory(history)).toBe('');
  });

  it('returns empty string when a JSON array has no text blocks', () => {
    const history = [userMsg(JSON.stringify([{ image: { format: 'png' } }]))];
    expect(extractQueryTextFromHistory(history)).toBe('');
  });

  it('handles a JSON string (not array) content by returning it trimmed', () => {
    const history = [userMsg(JSON.stringify('  a stringified query  '))];
    expect(extractQueryTextFromHistory(history)).toBe('a stringified query');
  });
});
