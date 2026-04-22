import { describe, expect, test } from 'vitest';
import { shouldResetReportTimer, toolNamesThatResetReportTimer } from './index';

describe('shouldResetReportTimer', () => {
  test('returns true for sendMessageToUser', () => {
    expect(shouldResetReportTimer('sendMessageToUser')).toBe(true);
  });

  test('returns true for sendMessageToAgent', () => {
    expect(shouldResetReportTimer('sendMessageToAgent')).toBe(true);
  });

  test('returns true for acknowledgeAgent', () => {
    expect(shouldResetReportTimer('acknowledgeAgent')).toBe(true);
  });

  test('returns false for unrelated tools', () => {
    expect(shouldResetReportTimer('executeCommand')).toBe(false);
    expect(shouldResetReportTimer('fileEditor')).toBe(false);
    expect(shouldResetReportTimer('cloneGitHubRepository')).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(shouldResetReportTimer(undefined)).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(shouldResetReportTimer('')).toBe(false);
  });
});

describe('toolNamesThatResetReportTimer', () => {
  test('contains exactly the three expected tool names', () => {
    expect(toolNamesThatResetReportTimer.size).toBe(3);
    expect(toolNamesThatResetReportTimer.has('sendMessageToUser')).toBe(true);
    expect(toolNamesThatResetReportTimer.has('sendMessageToAgent')).toBe(true);
    expect(toolNamesThatResetReportTimer.has('acknowledgeAgent')).toBe(true);
  });
});
