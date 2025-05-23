import { redirect } from 'next/navigation';
import { getSession, UserNotCreatedError } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function AuthCallbackPage() {
  try {
    await getSession();
  } catch (e) {
    console.log(e);
    if (e instanceof UserNotCreatedError) {
      const userId = e.userId;
      console.log(userId);
    } else {
      throw e;
    }
  }
  redirect('/');
}
