import { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import './globals.css';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Get the locale from the request
  const locale = await getLocale();
  // Get the messages for the current locale
  const messages = await getMessages();
  const isLocal = process.env.IS_LOCAL == 'true';
  const title = isLocal ? 'Remote SWE Agents (local)' : 'Remote SWE Agents';

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <title>{title}</title>
        <meta name="robots" content="noindex, nofollow" />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            {children}
            <Toaster position="top-right" closeButton={true} />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
