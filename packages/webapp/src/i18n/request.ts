import { getUserLocale } from './db';
import { getRequestConfig } from 'next-intl/server';

export const locales = ['en', 'ja'] as const;
export type Locale = (typeof locales)[number];
export default getRequestConfig(async () => {
  const locale = await getUserLocale();

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
