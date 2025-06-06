import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';

// This file is critical for webapp authentication mechanism.
// DO NOT remove any existing logic if you are not sure!
console.log('load middleware');

export async function middleware(request: NextRequest) {
  console.log('enter middleware');

  const response = NextResponse.next();

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

  console.log('exit middleware');

  if (authenticated) {
    return response;
  }

  return NextResponse.redirect(new URL('/sign-in', request.url));
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
    '/((?!api|_next/static|_next/image|favicon.ico|sign-in).*)',
  ],
};
