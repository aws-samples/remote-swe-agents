import { cookies } from 'next/headers';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';

export class UserNotCreatedError {
  constructor(public readonly userId: string) {}
}

/**
 * Derive a human-readable display name from a Cognito email.
 *
 * Policy: use the local part of the email (everything before `@`).
 * If the email has no `@`, use the email as-is. If the email is empty,
 * fall back to the userId. Mirrors `deriveDisplayName` in safe-action.ts
 * so server-page-rendered bubbles and server-action submissions agree on
 * the same display name for the same user.
 */
function deriveDisplayName(email: string | undefined, userId: string): string {
  if (email) {
    const at = email.indexOf('@');
    if (at > 0) return email.slice(0, at);
    return email;
  }
  return userId;
}

export async function getSession() {
  const session = await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) => fetchAuthSession(contextSpec),
  });
  if (session.userSub == null || session.tokens?.idToken == null || session.tokens?.accessToken == null) {
    throw new Error('session not found');
  }
  const userId = session.userSub;
  const email = session.tokens.idToken.payload.email;
  if (typeof email != 'string') {
    throw new Error(`invalid email ${userId}.`);
  }
  return {
    userId,
    email,
    displayName: deriveDisplayName(email, userId),
    accessToken: session.tokens.accessToken.toString(),
  };
}
