import { decodeJWT } from 'aws-amplify/auth';
import { Amplify } from 'aws-amplify';
import { CONNECTION_STATE_CHANGE, events } from 'aws-amplify/data';
import { Hub } from 'aws-amplify/utils';
import { useEffect } from 'react';
import {
  CATCH_UP_POLL_INTERVAL_MS,
  ConnectionHealthTracker,
  reconnectDelayMs,
  shouldReconnectOnVisible,
} from '@/lib/realtime-connection';

Amplify.configure(
  {
    API: {
      Events: {
        endpoint: `${process.env.NEXT_PUBLIC_EVENT_HTTP_ENDPOINT}/event`,
        region: process.env.NEXT_PUBLIC_AWS_REGION,
        defaultAuthMode: 'userPool',
      },
    },
  },
  {
    Auth: {
      tokenProvider: {
        getTokens: async () => {
          const res = await fetch('/api/cognito-token');
          const { accessToken } = await res.json();
          return {
            accessToken: decodeJWT(accessToken),
          };
        },
      },
    },
  }
);

type UseEventBusProps = {
  channelName: string;
  onReceived: (payload: unknown) => void;
  onConnected?: () => void;
  onError?: (err: unknown) => void;
  /**
   * Called when realtime connectivity has (re-)established after a window in
   * which events may have been lost, and periodically (while the page is
   * visible) as long as the connection is known-unhealthy. AppSync Events has
   * no replay: events published while the socket was down are gone, so use
   * this to reconcile client state from server-side data (e.g.
   * `router.refresh()` or re-running a fetch action). Must be referentially
   * stable (wrap in `useCallback`), like the other callbacks.
   */
  onReconnected?: () => void;
};

export const useEventBus = ({ channelName, onReceived, onConnected, onError, onReconnected }: UseEventBusProps) => {
  useEffect(() => {
    let channel: Awaited<ReturnType<typeof events.connect>> | null = null;
    let isMounted = true;
    // Increments on every (re)connect request and on unmount so that stale
    // in-flight connects and their subscription callbacks can detect they
    // have been superseded and dispose themselves.
    let generation = 0;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const health = new ConnectionHealthTracker();

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    // Re-establish the subscription after a failure. The Amplify client
    // re-subscribes existing subscriptions when *it* detects a disconnect,
    // but a subscription that errored out (e.g. start-ack timeout on a
    // half-open socket, auth failure at connect time) stays dead unless we
    // retry it ourselves.
    const scheduleReconnect = () => {
      if (!isMounted || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connectAndSubscribe();
      }, reconnectDelayMs(retryAttempt++));
    };

    const connectAndSubscribe = async () => {
      const gen = ++generation;
      if (channel) {
        channel.close();
        channel = null;
      }
      try {
        const ch = await events.connect(`event-bus/${channelName}`);
        if (!isMounted || gen !== generation) {
          ch.close();
          return;
        }
        channel = ch;
        ch.subscribe({
          next: (data) => {
            onReceived(data.event);
          },
          error: (err) => {
            console.error('EventBus error:', err);
            onError?.(err);
            if (isMounted && gen === generation) {
              // Subscription-level failures (e.g. EVENT_SUBSCRIBE_ERROR on an
              // expired token) don't close the socket, so the connection
              // state monitor never reports a lossy state. Track the loss
              // window here so the catch-up fires once we resubscribe.
              health.markDisrupted();
              scheduleReconnect();
            }
          },
        });
        retryAttempt = 0;
        if (health.recordSubscriptionEstablished()) {
          onReconnected?.();
        }
        onConnected?.();
      } catch (err) {
        console.error('EventBus connect error:', err);
        onError?.(err);
        if (isMounted && gen === generation) {
          health.markDisrupted();
          scheduleReconnect();
        }
      }
    };

    connectAndSubscribe();

    // Monitor the health of the shared AppSync Events WebSocket. The Amplify
    // client detects silent (half-open) disconnects via keep-alive monitoring
    // and reconnects + re-subscribes on its own, but events published while
    // the socket was down are lost forever (no replay). Whenever
    // connectivity returns after a lossy window we notify the consumer so it
    // can reconcile from server-side data.
    const stopHubListener = Hub.listen('api', ({ payload }) => {
      if (payload.event !== CONNECTION_STATE_CHANGE) return;
      const state = (payload.data as { connectionState?: string } | undefined)?.connectionState;
      if (!state) return;
      const catchUpNeeded = health.recordState(state);
      if (state === 'Connected') {
        retryAttempt = 0;
      }
      if (catchUpNeeded && isMounted) {
        onReconnected?.();
      }
    });

    // While the connection is known-unhealthy, keep the UI usable by
    // periodically reconciling from the server (the client can take up to
    // 5 minutes to hard-recover a half-open socket). Skipped for hidden
    // tabs (visibilitychange covers those on return) and while the browser
    // knows it is offline (the fetch would just fail; the 'online' handler
    // below kicks in the moment connectivity returns).
    const pollTimer = setInterval(() => {
      if (!isMounted || !health.isDisrupted) return;
      if (document.visibilityState !== 'visible') return;
      if (!navigator.onLine) return;
      onReconnected?.();
    }, CATCH_UP_POLL_INTERVAL_MS);

    const forceReconnect = () => {
      if (!isMounted) return;
      clearRetryTimer();
      retryAttempt = 0;
      // The unsubscribe→resubscribe gap of a forced reconnect is itself a
      // window where published events are lost; make sure the catch-up runs
      // after the new subscription is up.
      health.markDisrupted();
      connectAndSubscribe();
    };

    // Timestamp of the last transition to 'hidden'. Used to compute how long
    // the page stayed in the background when it becomes visible again.
    let hiddenAt: number | null = null;
    const onVisibilityChange = () => {
      if (!isMounted) return;
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      const hiddenDurationMs = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      // Skip quick alt-tabs while the connection is healthy: a forced
      // reconnect always ends in the consumer's catch-up (full RSC refresh),
      // which is expensive on mobile. Long background periods reconnect
      // immediately (mobile browsers freeze sockets there), and a socket that
      // silently died during a short hide is still recovered by the
      // keep-alive monitor + CONNECTION_STATE_CHANGE path.
      if (!shouldReconnectOnVisible(health.isDisrupted, hiddenDurationMs)) {
        return;
      }
      console.log('Page became visible, reconnecting EventBus...');
      forceReconnect();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // When the browser regains network connectivity, don't wait for the
    // keep-alive machinery to notice — reconnect right away.
    window.addEventListener('online', forceReconnect);

    return () => {
      isMounted = false;
      generation++;
      clearRetryTimer();
      clearInterval(pollTimer);
      stopHubListener();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', forceReconnect);
      if (channel) {
        channel.close();
      }
    };
  }, [channelName, onReceived, onConnected, onError, onReconnected]);
};
