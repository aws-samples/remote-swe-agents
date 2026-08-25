import { describe, it, expect } from 'vitest';
import { categorizeError, isPermanentError, getPermanentErrorHint, getRecoveryHint } from './error-taxonomy';

describe('categorizeError', () => {
  it('classifies throttling errors', () => {
    expect(categorizeError(new Error('ThrottlingException: Rate exceeded'))).toBe('throttling');
  });

  it('classifies validation errors', () => {
    expect(categorizeError(new Error('ValidationException: Invalid input'))).toBe('validation_error');
  });

  it('classifies model errors', () => {
    expect(categorizeError(new Error('ModelErrorException: Internal failure'))).toBe('model_error');
  });

  it('classifies service unavailable', () => {
    expect(categorizeError(new Error('ServiceUnavailableException'))).toBe('service_unavailable');
  });

  it('classifies max tokens exceeded', () => {
    expect(categorizeError(new Error('Max tokens exceeded too many times'))).toBe('max_output_tokens_exceeded');
  });

  it('returns unknown_error for unrecognized', () => {
    expect(categorizeError(new Error('Something random'))).toBe('unknown_error');
  });
});

describe('isPermanentError', () => {
  it('treats validation_error as permanent', () => {
    expect(isPermanentError('validation_error', 'ValidationException')).toBe(true);
  });

  it('treats invalid_request_error as permanent', () => {
    expect(isPermanentError('unknown_error', 'invalid_request_error happened')).toBe(true);
  });

  it('treats image dimensions exceeded as permanent', () => {
    expect(isPermanentError('unknown_error', 'Image dimensions exceed maximum')).toBe(true);
  });

  it('does not treat throttling as permanent', () => {
    expect(isPermanentError('throttling', 'ThrottlingException')).toBe(false);
  });

  it('does not treat model_error as permanent', () => {
    expect(isPermanentError('model_error', 'ModelErrorException')).toBe(false);
  });
});

describe('getRecoveryHint', () => {
  it('returns specific hint for each error type', () => {
    expect(getRecoveryHint('throttling', '')).toContain('rate-limited');
    expect(getRecoveryHint('validation_error', 'bad input')).toContain('validation error');
    expect(getRecoveryHint('model_error', '')).toContain('internal error');
    expect(getRecoveryHint('unknown_error', '')).toContain('unexpected error');
  });
});

// NOTE: The 3 "error recovery invokeArg invariant" tests were replaced by
// invoke-loop.test.ts which exercises the PRODUCTION invoke loop code path
// with DI. The old tests only asserted local variables (reviewer finding ).
