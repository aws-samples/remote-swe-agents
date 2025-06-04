import { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import './globals.css';
import { Toaster } from 'sonner';
import { ThemeProvider } from 'next-themes';
import { cookies } from 'next/headers';
import { locales, Locale } from '@/i18n/config';

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Get the locale from the request
  let locale = await getLocale();

  // Try to get locale from cookie if available
  try {
    const cookieStore = cookies();
    const localeCookie = cookieStore.get('NEXT_LOCALE');
    if (localeCookie?.value && locales.includes(localeCookie.value as Locale)) {
      locale = localeCookie.value;
    }
  } catch (e) {
    // If cookies() fails, fall back to the locale from getLocale()
    console.error('Error reading locale cookie:', e);
  }

  // Load messages
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <title>Remote SWE Agents</title>
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            {children}
            <Toaster position="top-right" />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
