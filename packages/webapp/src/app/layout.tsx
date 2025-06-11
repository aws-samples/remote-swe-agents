import { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import './globals.css';
import { Toaster } from 'sonner';
import { ThemeProvider } from 'next-themes';

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Get the locale from the request
  const locale = await getLocale();
  // Get the messages for the current locale
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
