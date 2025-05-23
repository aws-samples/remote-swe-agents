import { createAuthRouteHandlers } from '@/lib/amplifyServerUtils';

export const GET = createAuthRouteHandlers({
  redirectOnSignInComplete: '/auth-callback',
  redirectOnSignOutComplete: '/sign-in',
});
