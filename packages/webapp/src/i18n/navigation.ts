import { createLocalizedPathnamesNavigation } from 'next-intl/navigation';
import { locales } from './config';

export const { Link, redirect, usePathname, useRouter } = createLocalizedPathnamesNavigation({
  locales,
  pathnames: {
    // Specify all your pathnames here
    '/': '/',
    '/sessions': '/sessions',
    '/sessions/new': '/sessions/new',
    '/sessions/[workerId]': '/sessions/[workerId]',
    '/sign-in': '/sign-in',
  },
});
