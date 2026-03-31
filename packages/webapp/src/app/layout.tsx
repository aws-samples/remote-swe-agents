import { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import './globals.css';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { getPreferences } from '@remote-swe-agents/agent-core/lib';
import BadgeSyncer from '@/components/BadgeSyncer';

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Get the locale from the request
  const locale = await getLocale();
  // Get the messages for the current locale
  const messages = await getMessages();
  const isLocal = process.env.IS_LOCAL == 'true';
  const preferences = await getPreferences();
  const hasCustomIcon = !!preferences.defaultAgentIconKey;
  const title = isLocal ? 'Remote SWE Agents (local)' : 'Remote SWE Agents';

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <title>{title}</title>
        <meta name="robots" content="noindex, nofollow" />
        <link rel="icon" href={hasCustomIcon ? '/api/agent-icon?size=64' : '/icon-192x192.png'} type="image/png" />
        <link rel="manifest" href={hasCustomIcon ? '/api/manifest' : '/manifest.json'} />
        <meta name="theme-color" content="#3b82f6" />
        <link rel="apple-touch-icon" href={hasCustomIcon ? '/api/agent-icon?size=192' : '/icon-192x192.png'} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            {children}
            <Toaster position="top-right" closeButton={true} />
            <BadgeSyncer />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
