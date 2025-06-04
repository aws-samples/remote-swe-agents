import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';
import createIntlMiddleware from 'next-intl/middleware';
import { locales } from './i18n/config';

// Create intl middleware
const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale: 'en',
  localeDetection: true,
});

export async function middleware(request: NextRequest) {
  // First, handle internationalization
  const intlResponse = intlMiddleware(request);
  
  // Extract the response to work with it
  const response = (intlResponse instanceof Response) 
    ? intlResponse
    : NextResponse.next();
  
  // For auth-protected routes, check authentication
  if (!shouldSkipAuth(request.nextUrl.pathname)) {
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
  
    if (!authenticated) {
      // Handle locale in the redirect URL
      const locale = request.nextUrl.pathname.split('/')[1];
      const signInUrl = isValidLocale(locale) 
        ? `/${locale}/sign-in` 
        : '/sign-in';
      
      return NextResponse.redirect(new URL(signInUrl, request.url));
    }
  }
  
  return response;
}

// Helper to determine if a string is a valid locale
function isValidLocale(locale: string): boolean {
  return locales.includes(locale as any);
}

// Helper to check if this route should skip auth check
function shouldSkipAuth(pathname: string): boolean {
  // Skip auth check for sign-in page and static assets
  const pathSegments = pathname.split('/').filter(Boolean);
  
  // If first segment is a locale, look at the second segment
  if (pathSegments.length > 0 && isValidLocale(pathSegments[0])) {
    return pathSegments[1] === 'sign-in';
  }
  
  return pathname.includes('/sign-in');
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next (Next.js resources)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next|favicon.ico).*)',
  ],
};
