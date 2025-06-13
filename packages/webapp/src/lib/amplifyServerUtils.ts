import { AppOrigin } from '@/lib/origin';
import { createServerRunner } from '@aws-amplify/adapter-nextjs';

process.env.AMPLIFY_APP_ORIGIN = AppOrigin;

export const { runWithAmplifyServerContext, createAuthRouteHandlers } = createServerRunner({
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
      maxAge: 60 * 60 * 24 * 7, // 7 days
    },
  },
});
