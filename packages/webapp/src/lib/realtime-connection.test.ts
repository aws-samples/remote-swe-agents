import { describe, expect, it } from 'vitest';
import {
  ConnectionHealthTracker,
  MIN_HIDDEN_DURATION_FOR_RECONNECT_MS,
  reconnectDelayMs,
  shouldReconnectOnVisible,
} from './realtime-connection';

describe('ConnectionHealthTracker', () => {
  it('does not request catch-up on the initial connect sequence', () => {
    const tracker = new ConnectionHealthTracker();
    expect(tracker.recordState('Disconnected')).toBe(false);
    expect(tracker.recordState('Connecting')).toBe(false);
    expect(tracker.recordState('Connected')).toBe(false);
    expect(tracker.isDisrupted).toBe(false);
  });

  it('requests catch-up when the connection recovers after a disruption', () => {
    const tracker = new ConnectionHealthTracker();
    tracker.recordState('Connected');
    expect(tracker.recordState('ConnectionDisrupted')).toBe(false);
    expect(tracker.isDisrupted).toBe(true);
    expect(tracker.recordState('Connecting')).toBe(false);
    expect(tracker.recordState('Connected')).toBe(true);
    expect(tracker.isDisrupted).toBe(false);
  });

  it('requests catch-up after a silent disconnect detected via keep-alive', () => {
    const tracker = new ConnectionHealthTracker();
    tracker.recordState('Connected');
    expect(tracker.recordState('ConnectedPendingKeepAlive')).toBe(false);
    expect(tracker.isDisrupted).toBe(true);
    // keep-alive resumes without a full reconnect
    expect(tracker.recordState('Connected')).toBe(true);
  });

  it('requests catch-up when network drops and comes back', () => {
    const tracker = new ConnectionHealthTracker();
    tracker.recordState('Connected');
    tracker.recordState('ConnectedPendingNetwork');
    tracker.recordState('ConnectionDisruptedPendingNetwork');
    tracker.recordState('Connecting');
    expect(tracker.recordState('Connected')).toBe(true);
  });

  it('treats a clean disconnect after having been connected as lossy', () => {
    const tracker = new ConnectionHealthTracker();
    tracker.recordState('Connected');
    tracker.recordState('ConnectedPendingDisconnect');
    tracker.recordState('Disconnected');
    expect(tracker.isDisrupted).toBe(true);
    expect(tracker.recordState('Connected')).toBe(true);
  });

  it('requests catch-up when mounting while disrupted, once connected', () => {
    // e.g. page loads while offline: SSR data goes stale until the socket
    // finally connects, so a reconciliation is required then.
    const tracker = new ConnectionHealthTracker();
    tracker.recordState('Disconnected');
    tracker.recordState('Connecting');
    tracker.recordState('ConnectionDisrupted');
    expect(tracker.recordState('Connected')).toBe(true);
  });

  it('only requests catch-up once per disruption', () => {
    const tracker = new ConnectionHealthTracker();
    tracker.recordState('Connected');
    tracker.recordState('ConnectionDisrupted');
    expect(tracker.recordState('Connected')).toBe(true);
    expect(tracker.recordState('Connected')).toBe(false);
  });

  it('requests catch-up when a subscription error is recovered by resubscribing (C1)', () => {
    // EVENT_SUBSCRIBE_ERROR / GQL_ERROR paths never emit a lossy Hub state
    // (the socket stays open), so the hook marks the disruption itself and
    // the catch-up fires when its own retry re-establishes the subscription.
    const tracker = new ConnectionHealthTracker();
    tracker.recordState('Connected');
    tracker.markDisrupted();
    expect(tracker.isDisrupted).toBe(true);
    expect(tracker.recordSubscriptionEstablished()).toBe(true);
    expect(tracker.isDisrupted).toBe(false);
    // subsequent healthy resubscribes don't re-fire
    expect(tracker.recordSubscriptionEstablished()).toBe(false);
  });

  it('does not request catch-up on the initial subscribe (no prior disruption)', () => {
    const tracker = new ConnectionHealthTracker();
    expect(tracker.recordSubscriptionEstablished()).toBe(false);
  });

  it('fires the catch-up exactly once when both recovery signals arrive (C1 + Hub)', () => {
    const tracker = new ConnectionHealthTracker();
    tracker.recordState('Connected');
    tracker.markDisrupted();
    // hook's own resubscribe wins the race...
    expect(tracker.recordSubscriptionEstablished()).toBe(true);
    // ...then the Hub reports Connected for the same recovery: no double fire
    expect(tracker.recordState('Connected')).toBe(false);
  });

  it('requests catch-up after a forced reconnect gap (W1)', () => {
    const tracker = new ConnectionHealthTracker();
    tracker.recordState('Connected');
    // visibilitychange / online handler closes and reopens the subscription
    tracker.markDisrupted();
    expect(tracker.recordSubscriptionEstablished()).toBe(true);
  });
});

describe('reconnectDelayMs', () => {
  it('grows exponentially from 1s', () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(3)).toBe(8000);
  });

  it('caps at 30s', () => {
    expect(reconnectDelayMs(5)).toBe(30_000);
    expect(reconnectDelayMs(100)).toBe(30_000);
  });

  it('handles negative attempts defensively', () => {
    expect(reconnectDelayMs(-1)).toBe(1000);
  });
});

describe('shouldReconnectOnVisible', () => {
  it('skips a quick alt-tab while healthy', () => {
    expect(shouldReconnectOnVisible(false, MIN_HIDDEN_DURATION_FOR_RECONNECT_MS - 1)).toBe(false);
  });

  it('reconnects after a long background period', () => {
    expect(shouldReconnectOnVisible(false, MIN_HIDDEN_DURATION_FOR_RECONNECT_MS)).toBe(true);
  });

  it('always reconnects immediately when the connection is known-disrupted', () => {
    expect(shouldReconnectOnVisible(true, 0)).toBe(true);
  });

  it('treats an unknown hidden duration (never hidden) as short', () => {
    expect(shouldReconnectOnVisible(false, 0)).toBe(false);
  });
});
