import { decodeJWT } from 'aws-amplify/auth';
import { Amplify } from 'aws-amplify';
import { events } from 'aws-amplify/data';
import { useEffect } from 'react';

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
};

export const useEventBus = ({ channelName, onReceived, onConnected, onError }: UseEventBusProps) => {
  useEffect(() => {
    let channel: Awaited<ReturnType<typeof events.connect>> | null = null;
    let isMounted = true;

    const connectAndSubscribe = async () => {
      try {
        const ch = await events.connect(`event-bus/${channelName}`);
        if (!isMounted) {
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
          },
        });
        onConnected?.();
      } catch (err) {
        console.error('EventBus connect error:', err);
        onError?.(err);
      }
    };

    connectAndSubscribe();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isMounted) {
        console.log('Page became visible, reconnecting EventBus...');
        if (channel) {
          channel.close();
          channel = null;
        }
        connectAndSubscribe();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      isMounted = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (channel) {
        channel.close();
      }
    };
  }, [channelName, onReceived, onConnected, onError]);
};
