import { describe, expect, test } from 'vitest';
import { sanitizeUserId } from './kiro-api-key';

describe('sanitizeUserId', () => {
  test('strips webapp# prefix', () => {
    expect(sanitizeUserId('webapp#97546ab8-b0f1-7031-24ca-6b8affdc65f3')).toBe('97546ab8-b0f1-7031-24ca-6b8affdc65f3');
  });

  test('strips slack# prefix', () => {
    expect(sanitizeUserId('slack#U12345ABC')).toBe('U12345ABC');
  });

  test('passes through plain UUID', () => {
    expect(sanitizeUserId('97546ab8-b0f1-7031-24ca-6b8affdc65f3')).toBe('97546ab8-b0f1-7031-24ca-6b8affdc65f3');
  });

  test('passes through alphanumeric userId', () => {
    expect(sanitizeUserId('user123')).toBe('user123');
  });

  test('allows dots and underscores', () => {
    expect(sanitizeUserId('user.name_123')).toBe('user.name_123');
  });

  test('throws on path traversal attempt', () => {
    expect(() => sanitizeUserId('../../etc/passwd')).toThrow('Invalid userId');
  });

  test('throws on shell injection attempt', () => {
    expect(() => sanitizeUserId('user; rm -rf /')).toThrow('Invalid userId');
  });

  test('throws on empty string after prefix strip', () => {
    expect(() => sanitizeUserId('webapp#')).toThrow('Invalid userId');
  });

  test('handles multiple # characters - takes last segment', () => {
    expect(sanitizeUserId('a#b#c123')).toBe('c123');
  });
});
