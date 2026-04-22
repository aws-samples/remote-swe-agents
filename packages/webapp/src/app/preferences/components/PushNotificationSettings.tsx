'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function PushNotificationSettings() {
  const t = useTranslations('preferences.pushNotifications');
  const nt = useTranslations('notifications');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  const checkSubscription = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }
    setIsSupported(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      if (registration) {
        const subscription = await registration.pushManager.getSubscription();
        setIsSubscribed(!!subscription);
      }
    } catch (error) {
      console.error('Failed to check push subscription:', error);
    }
  }, []);

  useEffect(() => {
    setIsMounted(true);
    checkSubscription();
  }, [checkSubscription]);

  const subscribe = async () => {
    setIsLoading(true);
    try {
      const vapidResponse = await fetch('/api/push/vapid-key');
      if (!vapidResponse.ok) {
        toast.error(nt('notConfigured'));
        return;
      }
      const { vapidPublicKey } = await vapidResponse.json();

      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error(nt('permissionDenied'));
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });

      if (response.ok) {
        setIsSubscribed(true);
        toast.success(nt('subscribed'));
      } else {
        toast.error(nt('subscribeFailed'));
      }
    } catch (error) {
      console.error('Failed to subscribe:', error);
      toast.error(nt('subscribeFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const unsubscribe = async () => {
    setIsLoading(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      if (registration) {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await subscription.unsubscribe();
          await fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });
        }
      }
      setIsSubscribed(false);
      toast.success(nt('unsubscribed'));
    } catch (error) {
      console.error('Failed to unsubscribe:', error);
      toast.error(nt('unsubscribeFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggle = (checked: boolean) => {
    if (checked) {
      subscribe();
    } else {
      unsubscribe();
    }
  };

  if (!isMounted) {
    return null;
  }

  if (!isSupported) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('notSupported')}</p>;
  }

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        {isSubscribed ? (
          <Bell className="h-5 w-5 text-blue-600 dark:text-blue-400" />
        ) : (
          <BellOff className="h-5 w-5 text-gray-400 dark:text-gray-500" />
        )}
        <label htmlFor="push-toggle" className="text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer">
          {isSubscribed ? t('enabled') : t('disabled')}
        </label>
      </div>
      <Switch id="push-toggle" checked={isSubscribed} onCheckedChange={handleToggle} disabled={isLoading} />
    </div>
  );
}
