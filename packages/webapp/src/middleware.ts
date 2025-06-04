import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';
import createMiddleware from 'next-intl/middleware';
import { locales } from '@/i18n/config';

// Create next-intl middleware
const intlMiddleware = createMiddleware({
  // A list of all locales that are supported
  locales: locales,
  // Used when no locale matches
  defaultLocale: 'en',
  // If using automatic language detection, use the following:
  localeDetection: true,
});

export async function middleware(request: NextRequest) {
  // First, handle internationalization
  const pathname = request.nextUrl.pathname;

  // Apply next-intl middleware only to paths that require it
  const isI18nPath = !pathname.includes('/api/') && !pathname.match(/^\/_next\//) && !pathname.includes('/favicon.ico');

  if (isI18nPath) {
    const response = intlMiddleware(request);
    if (response) {
      return response;
    }
  }

  // Then, handle authentication
  const response = NextResponse.next();

  // Skip auth check for sign-in page
  const shouldSkipAuth = pathname.includes('/sign-in');
  if (shouldSkipAuth) {
    return response;
  }

  // Check authentication
  const authenticated = await runWithAmplifyServerContext({
    nextServerContext: { request, response },
    operation: async (contextSpec) => {
      try {
        const session = await fetchAuthSession(contextSpec);
        return session.tokens?.accessToken !== undefined && session.tokens?.idToken !== undefined;
      } catch (error) {
        console.log(error);
        return false;
      }
    },
  });

  if (authenticated) {
    return response;
  }

  // Redirect to appropriate locale sign-in page
  const locale = pathname.split('/')[1];
  const signInPath = locales.includes(locale as any) ? `/${locale}/sign-in` : '/sign-in';
  return NextResponse.redirect(new URL(signInPath, request.url));
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
