import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { fetchAuthSession } from 'aws-amplify/auth/server';
import { runWithAmplifyServerContext } from '@/lib/amplifyServerUtils';

export async function GET() {
  try {
    const session = await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => fetchAuthSession(contextSpec),
    });

    if (session.tokens?.accessToken == null) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json({
      accessToken: session.tokens.accessToken.toString(),
    });
  } catch (error) {
    console.error('Error fetching Cognito token:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
