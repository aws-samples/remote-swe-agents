// Pure logic for monitoring the health of the AppSync Events WebSocket
// connection (kept free of aws-amplify imports so it is unit-testable in a
// node environment).
//
// Background: AppSync Events has no replay/catch-up — events published while
// the socket is down are lost forever. The Amplify client detects silent
// (half-open) disconnects via keep-alive monitoring and re-establishes the
// socket + subscriptions on its own, but it cannot recover the lost events.
// This tracker watches the CONNECTION_STATE_CHANGE Hub events and tells the
// caller when a reconciliation with server-side data is needed.

// Values mirror the `ConnectionState` enum exported from 'aws-amplify/data'.
export type RealtimeConnectionState =
  | 'Connected'
  | 'ConnectedPendingNetwork'
  | 'ConnectionDisrupted'
  | 'ConnectionDisruptedPendingNetwork'
  | 'Connecting'
  | 'ConnectedPendingDisconnect'
  | 'Disconnected'
  | 'ConnectedPendingKeepAlive';

// States that always indicate a real connectivity problem, regardless of
// whether we were connected before (e.g. mounting while offline).
const LOSSY_STATES: ReadonlySet<string> = new Set([
  'ConnectionDisrupted',
  'ConnectionDisruptedPendingNetwork',
  'ConnectedPendingNetwork',
  'ConnectedPendingKeepAlive',
]);

// States that are part of the normal connect/teardown sequence and only
// indicate potential event loss when they happen after a successful
// connection (the connection state monitor starts at 'Disconnected').
const LOSSY_STATES_AFTER_CONNECTED: ReadonlySet<string> = new Set(['Disconnected', 'ConnectedPendingDisconnect']);

export class ConnectionHealthTracker {
  private wasConnected = false;
  private disrupted = false;

  /**
   * Record a connection state change.
   * @returns true when connectivity has just recovered after a period where
   * events may have been lost — i.e. the caller should reconcile its state
   * from the server now.
   */
  recordState(state: string): boolean {
    if (state === 'Connected') {
      const catchUpNeeded = this.disrupted;
      this.wasConnected = true;
      this.disrupted = false;
      return catchUpNeeded;
    }
    if (LOSSY_STATES.has(state) || (this.wasConnected && LOSSY_STATES_AFTER_CONNECTED.has(state))) {
      this.disrupted = true;
    }
    return false;
  }

  /**
   * Record a disruption that the connection state monitor cannot see, e.g. a
   * subscription rejected with EVENT_SUBSCRIBE_ERROR / GQL_ERROR (the socket
   * stays open so no lossy Hub state is emitted, `observer.error` just
   * fires) or the deliberate unsubscribe→resubscribe gap during a forced
   * reconnect. Events published until the subscription is re-established are
   * lost, so a catch-up must follow.
   */
  markDisrupted(): void {
    this.disrupted = true;
  }

  /**
   * Record that a subscription was (re-)established by the hook's own
   * connect/retry path (as opposed to the Hub reporting 'Connected').
   * @returns true when the caller should reconcile from the server because
   * events may have been lost since the disruption. The flag is shared with
   * `recordState` so whichever recovery signal arrives first wins and the
   * catch-up fires exactly once per disruption.
   */
  recordSubscriptionEstablished(): boolean {
    const catchUpNeeded = this.disrupted;
    this.wasConnected = true;
    this.disrupted = false;
    return catchUpNeeded;
  }

  /** Whether events may currently be getting lost. */
  get isDisrupted(): boolean {
    return this.disrupted;
  }
}

/**
 * Exponential backoff for re-establishing a failed subscription:
 * 1s, 2s, 4s, ... capped at 30s.
 */
export const reconnectDelayMs = (attempt: number): number => {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 30_000);
};

/**
 * While the connection is known-unhealthy, consumers reconcile with the
 * server at this interval so the UI stays usable even before the socket
 * recovers (the Amplify client can take up to 5 minutes to hard-recover a
 * half-open socket via its keep-alive timeout).
 */
export const CATCH_UP_POLL_INTERVAL_MS = 30_000;

/**
 * Minimum time a page must have been hidden for a visibilitychange-to-visible
 * event to force a reconnect. Every forced reconnect deliberately marks the
 * connection disrupted, which makes the following resubscribe fire the
 * consumer's catch-up (typically a full `router.refresh()`), so an
 * unthrottled handler re-fetches the whole RSC payload on every quick
 * alt-tab. Gating on the *hidden duration* (rather than time since the last
 * reconnect) keeps long background periods — where mobile browsers freeze
 * sockets and events are likely lost — reconnecting immediately, with no
 * blind window: a brief hide almost certainly kept the socket alive, and if
 * it did silently die the Amplify keep-alive monitor still detects it and
 * the CONNECTION_STATE_CHANGE path triggers the reconcile.
 */
export const MIN_HIDDEN_DURATION_FOR_RECONNECT_MS = 30_000;

/**
 * Decide whether a visibilitychange-to-visible event should force a
 * reconnect now. Always reconnect when the connection is already known to be
 * disrupted (that path needs the fastest possible recovery); otherwise only
 * when the page was hidden long enough that the socket plausibly died.
 */
export const shouldReconnectOnVisible = (isDisrupted: boolean, hiddenDurationMs: number): boolean => {
  return isDisrupted || hiddenDurationMs >= MIN_HIDDEN_DURATION_FOR_RECONNECT_MS;
};
