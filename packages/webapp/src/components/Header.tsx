'use client';

import Link from 'next/link';
import { Menu, Languages, LogOut, Check, Key, Settings } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
} from './ui/dropdown-menu';
import { Button } from './ui/button';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { setUserLocale } from '@/i18n/db';
import { useScrollPosition } from '@/hooks/use-scroll-position';

export default function Header() {
  const t = useTranslations('header');
  const { localeOptions, currentLocale, changeLocale } = useLanguageSwitcher();
  const { isHeaderVisible } = useScrollPosition();

  return (
    <header
      className={`bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shadow-sm w-full fixed top-0 z-40 transition-transform duration-300 ${
        isHeaderVisible ? 'translate-y-0' : '-translate-y-full'
      }`}
    >
      <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8 w-full">
        <div className="flex justify-between h-16 items-center w-full">
          <div className="flex-shrink-0 min-w-0">
            <Link href="/" className="text-xl font-bold text-gray-900 dark:text-white truncate">
              {t('title')}
            </Link>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Menu">
                  <Menu className="h-5 w-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 z-50">
                <DropdownMenuLabel>{t('menu')}</DropdownMenuLabel>
                <DropdownMenuSeparator />

                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="flex items-center">
                    <Languages className="mr-2 h-4 w-4" />
                    <span>{t('language')}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent>
                      {localeOptions.map((option) => (
                        <DropdownMenuItem
                          key={option.value}
                          onClick={() => changeLocale(option.value)}
                          className="flex justify-between"
                        >
                          {option.label}
                          {currentLocale === option.value && <Check className="h-4 w-4 ml-2" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>

                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings/api-keys" className="w-full cursor-default flex items-center" prefetch={false}>
                    <Key className="mr-2 h-4 w-4" />
                    <span>{t('apiKeys')}</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/cost" className="w-full cursor-default flex items-center" prefetch={false}>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mr-2 h-4 w-4"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
                      <path d="M12 18V6" />
                    </svg>
                    <span>{t('costAnalysis')}</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/settings" className="w-full cursor-default flex items-center" prefetch={false}>
                    <Settings className="mr-2 h-4 w-4" />
                    <span>{t('preferences')}</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/api/auth/sign-out" className="w-full cursor-default flex items-center" prefetch={false}>
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>{t('signOut')}</span>
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </header>
  );
}

const localeOptions: {
  value: string;
  label: string;
}[] = [
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
];

function useLanguageSwitcher() {
  const [isPending, startTransition] = useTransition();
  const locale = useLocale();
  const router = useRouter();

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
