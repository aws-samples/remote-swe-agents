import { describe, expect, test } from 'vitest';

/**
 * Pure-logic tests for the sleeping indicator clear conditions used in
 * SessionSidebar. These validate the decision logic without rendering React.
 */

type EventType = 'agentStatusUpdate' | 'instanceStatusChanged';
type InstanceStatus = 'starting' | 'running' | 'stopped' | 'terminated';
type AgentStatus = 'working' | 'pending' | 'completed';

function shouldClearSleepIndicator(eventType: EventType, status: InstanceStatus | AgentStatus): boolean {
  if (eventType === 'agentStatusUpdate') return true;
  if (eventType === 'instanceStatusChanged') {
    return status === 'starting' || status === 'running';
  }
  return false;
}

describe('sleeping indicator clear logic', () => {
  describe('instanceStatusChanged', () => {
    test('starting → clears (worker waking up)', () => {
      expect(shouldClearSleepIndicator('instanceStatusChanged', 'starting')).toBe(true);
    });

    test('running → clears (worker alive)', () => {
      expect(shouldClearSleepIndicator('instanceStatusChanged', 'running')).toBe(true);
    });

    test('stopped → does NOT clear (emitted immediately after sleep)', () => {
      expect(shouldClearSleepIndicator('instanceStatusChanged', 'stopped')).toBe(false);
    });

    test('terminated → does NOT clear', () => {
      expect(shouldClearSleepIndicator('instanceStatusChanged', 'terminated')).toBe(false);
    });
  });

  describe('agentStatusUpdate', () => {
    test('working → clears (only live workers emit this)', () => {
      expect(shouldClearSleepIndicator('agentStatusUpdate', 'working')).toBe(true);
    });

    test('pending → clears', () => {
      expect(shouldClearSleepIndicator('agentStatusUpdate', 'pending')).toBe(true);
    });

    test('completed → clears', () => {
      expect(shouldClearSleepIndicator('agentStatusUpdate', 'completed')).toBe(true);
    });
  });
});
