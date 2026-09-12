import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';
import { fetchAuthSession, getCurrentUser } from 'aws-amplify/auth/server';
import { createSafeActionClient, DEFAULT_SERVER_ERROR_MESSAGE } from 'next-safe-action';
import { cookies } from 'next/headers';

export class MyCustomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MyCustomError';
  }
}

const actionClient = createSafeActionClient({
  handleServerError(e) {
    // Log to console.
    console.error('Action error:', e.message);

    // In this case, we can use the 'MyCustomError` class to unmask errors
    // and return them with their actual messages to the client.
    if (e instanceof MyCustomError) {
      return e.message;
    }

    // Every other error that occurs will be masked with the default message.
    return DEFAULT_SERVER_ERROR_MESSAGE;
  },
});

/**
 * Derive a human-readable display name from a Cognito email.
 *
 * Policy: use the local part of the email (everything
 * before `@`). If the email is missing / falsy, fall back to the full email,
 * and finally the Cognito sub. This keeps the display short and recognisable
 * without pulling additional IdP attributes.
 */
function deriveDisplayName(email: string | undefined, userId: string): string {
  if (email) {
    const at = email.indexOf('@');
    if (at > 0) return email.slice(0, at);
    return email;
  }
  return userId;
}

export const authActionClient = actionClient.use(async ({ next }) => {
  const [currentUser, authSession] = await Promise.all([
    runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => getCurrentUser(contextSpec),
    }),
    runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => fetchAuthSession(contextSpec),
    }),
  ]);

  if (!currentUser) {
    throw new Error('Session is not valid!');
  }

  const emailClaim = authSession.tokens?.idToken?.payload?.email;
  const email = typeof emailClaim === 'string' ? emailClaim : undefined;
  const displayName = deriveDisplayName(email, currentUser.userId);

  return next({ ctx: { userId: currentUser.userId, email, displayName } });
});
