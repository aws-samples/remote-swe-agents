import { AppOrigin } from '@/lib/origin';
import { createServerRunner } from '@aws-amplify/adapter-nextjs';

if (AppOrigin) {
  process.env.AMPLIFY_APP_ORIGIN = AppOrigin;
}

const isConfigured = !!(process.env.USER_POOL_ID && process.env.USER_POOL_CLIENT_ID && process.env.COGNITO_DOMAIN);

if (!isConfigured && process.env.NEXT_PHASE !== 'phase-production-build' && process.env.NODE_ENV === 'production') {
  throw new Error('Amplify auth is not configured. Set USER_POOL_ID, USER_POOL_CLIENT_ID, and COGNITO_DOMAIN.');
}

const serverRunner = isConfigured
  ? createServerRunner({
      config: {
        Auth: {
          Cognito: {
            userPoolId: process.env.USER_POOL_ID!,
            userPoolClientId: process.env.USER_POOL_CLIENT_ID!,
            loginWith: {
              oauth: {
                redirectSignIn: [`${AppOrigin}/api/auth/sign-in-callback`],
                redirectSignOut: [`${AppOrigin}/api/auth/sign-out-callback`],
                responseType: 'code',
                domain: process.env.COGNITO_DOMAIN!,
                scopes: ['profile', 'openid', 'aws.cognito.signin.user.admin'],
              },
            },
          },
        },
      },
      runtimeOptions: {
        cookies: {
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 30, // 30 days
        },
      },
    })
  : undefined;

export const runWithAmplifyServerContext: NonNullable<typeof serverRunner>['runWithAmplifyServerContext'] =
  serverRunner?.runWithAmplifyServerContext ??
  (() => {
    throw new Error('Amplify is not configured. Set USER_POOL_ID, USER_POOL_CLIENT_ID, and COGNITO_DOMAIN.');
  });

export const createAuthRouteHandlers: NonNullable<typeof serverRunner>['createAuthRouteHandlers'] =
  serverRunner?.createAuthRouteHandlers ??
  (() => {
    return async () => new Response('Auth not configured', { status: 503 });
  });
