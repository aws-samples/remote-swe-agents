'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { setUserLocale } from '@/i18n/db';
import { Check } from 'lucide-react';
import { ReactNode } from 'react';

interface LanguageSwitcherProps {
  mode?: 'dropdown' | 'select';
  onLocaleChange?: () => void;
}

interface LocaleOption {
  value: string;
  label: string;
}

export default function LanguageSwitcher({ mode = 'select', onLocaleChange }: LanguageSwitcherProps) {
  const [isPending, startTransition] = useTransition();
  const locale = useLocale();
  const router = useRouter();

  const localeOptions: LocaleOption[] = [
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
  ];

  function changeLocale(newLocale: string) {
    // Refresh the page to get the new messages
    startTransition(() => {
      setUserLocale(newLocale);
      router.refresh();
      if (onLocaleChange) {
        onLocaleChange();
      }
    });
  }

  // Function that renders a locale option with optional check mark for current locale
  function renderLocaleOption(option: LocaleOption, withCheck: boolean = false): ReactNode {
    const isActive = locale === option.value;

    return (
      <div key={option.value} className="flex items-center justify-between">
        <span>{option.label}</span>
        {withCheck && isActive && <Check className="h-4 w-4 ml-2" />}
      </div>
    );
  }

  // Legacy select dropdown for backwards compatibility
  if (mode === 'select') {
    return (
      <select
        value={locale}
        onChange={(e) => changeLocale(e.target.value)}
        disabled={isPending}
        className="w-full text-sm rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-800 bg-white py-1.5 px-2 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500"
      >
        {localeOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  // For dropdown mode, we expose methods to be used by dropdowns
  return null;
}

// Export helper methods for external use
export function useLanguageSwitcher() {
  const [isPending, startTransition] = useTransition();
  const locale = useLocale();
  const router = useRouter();

  const localeOptions = [
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
  ];

  const changeLocale = (newLocale: string) => {
    startTransition(() => {
      setUserLocale(newLocale);
      router.refresh();
    });
  };

  return {
    localeOptions,
    currentLocale: locale,
    isPending,
    changeLocale,
  };
}
