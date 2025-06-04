'use client';

import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { locales } from '@/i18n/config';
import { useCallback } from 'react';

export default function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('common');

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newLocale = e.target.value;
      router.replace(pathname, { locale: newLocale });
    },
    [pathname, router]
  );

  return (
    <select
      value={locale}
      onChange={handleChange}
      className="text-sm rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-800 bg-white py-1.5 px-2 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500"
    >
      {locales.map((l) => (
        <option key={l} value={l}>
          {t('locale', { locale: l })}
        </option>
      ))}
    </select>
  );
}