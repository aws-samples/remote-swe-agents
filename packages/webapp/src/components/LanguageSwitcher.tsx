'use client';

import { useState } from 'react';
import { useRouter, usePathname } from '@/i18n/navigation';
import { locales } from '@/i18n/config';

type Language = 'en' | 'ja';

const translations = {
  en: {
    english: 'English',
    japanese: '日本語',
  },
  ja: {
    english: 'English',
    japanese: '日本語',
  },
};

export default function LanguageSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const [language, setLanguage] = useState<Language>('en');

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = e.target.value as Language;
    setLanguage(newLanguage);
    router.replace(pathname, { locale: newLanguage });
  };

  return (
    <select
      value={language}
      onChange={handleLanguageChange}
      className="text-sm rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-800 bg-white py-1.5 px-2 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500"
    >
      <option value="en">{translations[language].english}</option>
      <option value="ja">{translations[language].japanese}</option>
    </select>
  );
}
