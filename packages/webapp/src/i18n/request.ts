import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

export const locales = ['en', 'ja'] as const;
export type Locale = (typeof locales)[number];

export default getRequestConfig(async ({ locale: defaultLocale }) => {
  // Get locale from cookie if it exists
  const localeCookie = cookies().get('NEXT_LOCALE');
  const locale = (localeCookie?.value as Locale) || defaultLocale;

  return {
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
