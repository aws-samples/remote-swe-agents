'use client';

import { useState, useEffect, useCallback } from 'react';
import { Bell, X } from 'lucide-react';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

const DISMISSED_KEY = 'push-notification-banner-dismissed';

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

export default function PushNotificationBanner() {
  const t = useTranslations('notifications');
  const [isVisible, setIsVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const check = async () => {
      if (localStorage.getItem(DISMISSED_KEY)) return;
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

      try {
        const registration = await navigator.serviceWorker.getRegistration('/sw.js');
        if (registration) {
          const subscription = await registration.pushManager.getSubscription();
          if (subscription) return;
        }
      } catch {
        // ignore
      }

      setIsVisible(true);
    };
    check();
  }, []);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, 'true');
    setIsVisible(false);
  }, []);

  const enable = useCallback(async () => {
    setIsLoading(true);
    try {
      const vapidResponse = await fetch('/api/push/vapid-key');
      if (!vapidResponse.ok) {
        toast.error(t('notConfigured'));
        dismiss();
        return;
      }
      const { vapidPublicKey } = await vapidResponse.json();

      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error(t('permissionDenied'));
        dismiss();
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
        toast.success(t('subscribed'));
      } else {
        toast.error(t('subscribeFailed'));
      }
    } catch (error) {
      console.error('Failed to subscribe:', error);
      toast.error(t('subscribeFailed'));
    } finally {
      setIsLoading(false);
      dismiss();
    }
  }, [t, dismiss]);

  if (!isVisible) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-4 animate-in slide-in-from-bottom-5 duration-300">
      <button
        onClick={dismiss}
        className="absolute top-2 right-2 p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
      >
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 p-2 bg-blue-100 dark:bg-blue-900/30 rounded-full">
          <Bell className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white">{t('banner.title')}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('banner.description')}</p>
          <div className="flex items-center gap-2 mt-3">
            <Button size="sm" onClick={enable} disabled={isLoading}>
              {t('banner.enable')}
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              {t('banner.later')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
