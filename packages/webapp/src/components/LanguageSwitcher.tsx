'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { setUserLocale } from '@/i18n/db';

export default function LanguageSwitcher() {
  const [isPending, startTransition] = useTransition();
  const locale = useLocale();
  const router = useRouter();

  async function changeLocale(newLocale: string) {
    // Store the preference in a cookie

    // Refresh the page to get the new messages
    startTransition(() => {
      setUserLocale(newLocale);
      router.refresh();
    });
  }

  return (
    <select
      value={locale}
      onChange={(e) => changeLocale(e.target.value)}
      disabled={isPending}
      className="text-sm rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-800 bg-white py-1.5 px-2 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500"
    >
      <option value="en">English</option>
      <option value="ja">日本語</option>
    </select>
  );
}
