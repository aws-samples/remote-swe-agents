'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import LanguageSwitcher from './LanguageSwitcher';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface HamburgerMenuProps {
  close: () => void;
}

export default function HamburgerMenu({ close }: HamburgerMenuProps) {
  const t = useTranslations('header');
  const menuRef = useRef<HTMLDivElement>(null);

  // Animation effect
  useEffect(() => {
    const menu = menuRef.current;
    if (menu) {
      // Trigger animation after mount
      requestAnimationFrame(() => {
        menu.style.transform = 'translateX(0)';
      });
    }

    // Add escape key listener
    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };

    window.addEventListener('keydown', handleEscKey);
    return () => {
      window.removeEventListener('keydown', handleEscKey);
    };
  }, [close]);

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-20">
      <div
        ref={menuRef}
        className="absolute right-0 top-0 h-full w-64 bg-white dark:bg-gray-900 shadow-lg p-4 transform transition-transform duration-300 ease-in-out translate-x-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('menu')}</h2>
          <button
            onClick={close}
            className="p-1 rounded-md text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6">
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('language')}</p>
            <LanguageSwitcher />
          </div>

          <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
            <Link
              href="/api/auth/sign-out"
              className="inline-flex items-center px-4 py-2 w-full justify-center border border-gray-300 dark:border-gray-600 text-sm rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-offset-gray-900 focus:ring-offset-2"
              prefetch={false} // prevent CORS error
              onClick={close}
            >
              {t('signOut')}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
