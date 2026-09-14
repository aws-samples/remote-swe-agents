import { describe, expect, test, beforeEach } from 'vitest';
import { raiseMissedEvents, consumeMissedEvents, clearMissedEvents } from './missed-events-signal';

describe('missed-events-signal', () => {
  beforeEach(() => {
    // Drain any residual signal so tests are order-independent.
    clearMissedEvents();
  });

  test('starts cleared', () => {
    expect(consumeMissedEvents()).toBe(false);
  });

  test('raise then consume returns true exactly once', () => {
    raiseMissedEvents();
    expect(consumeMissedEvents()).toBe(true);
    expect(consumeMissedEvents()).toBe(false);
  });

  test('raise is idempotent within a window', () => {
    raiseMissedEvents();
    raiseMissedEvents();
    expect(consumeMissedEvents()).toBe(true);
    expect(consumeMissedEvents()).toBe(false);
  });

  test('re-raise after consume works again', () => {
    raiseMissedEvents();
    expect(consumeMissedEvents()).toBe(true);
    raiseMissedEvents();
    expect(consumeMissedEvents()).toBe(true);
  });

  // --- W1: clearMissedEvents cancels a tentative raise (unread-count race) ---

  test('clear undoes a raise so consume sees nothing', () => {
    raiseMissedEvents();
    clearMissedEvents();
    expect(consumeMissedEvents()).toBe(false);
  });

  test('clear is safe when nothing was raised', () => {
    clearMissedEvents();
    expect(consumeMissedEvents()).toBe(false);
  });

  test('raise after clear is still observable (real miss survives)', () => {
    raiseMissedEvents();
    clearMissedEvents();
    raiseMissedEvents();
    expect(consumeMissedEvents()).toBe(true);
  });
});
