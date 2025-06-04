'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getCookie, setCookie } from 'cookies-next';

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
  const [language, setLanguage] = useState<Language>('en');

  useEffect(() => {
    const savedLang = getCookie('language') as Language;
    if (savedLang) {
      setLanguage(savedLang);
    }
  }, []);

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLanguage = e.target.value as Language;
    setLanguage(newLanguage);
    setCookie('language', newLanguage, { maxAge: 60 * 60 * 24 * 365 }); // 1 year
    router.refresh();
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
