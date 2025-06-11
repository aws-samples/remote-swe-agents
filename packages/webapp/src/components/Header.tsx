'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Menu, Languages, LogOut, Check } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import { useLanguageSwitcher } from './LanguageSwitcher';
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

export default function Header() {
  const t = useTranslations('header');
  const { localeOptions, currentLocale, changeLocale } = useLanguageSwitcher();

  return (
    <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16 items-center">
          <div className="flex-shrink-0">
            <Link href="/" className="text-xl font-bold text-gray-900 dark:text-white">
              {t('title')}
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Menu">
                  <Menu className="h-5 w-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
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
