import { createAuthRouteHandlers } from '@/lib/amplifyServerUtils';

export const dynamic = 'force-dynamic';

export const GET = createAuthRouteHandlers({
  redirectOnSignInComplete: '/auth-callback',
  redirectOnSignOutComplete: '/sign-in',
});
