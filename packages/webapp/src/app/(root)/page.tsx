import { getSession } from '@/lib/auth';
import Header from '@/components/Header';

export default async function Home() {
  const { userId } = await getSession();
  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-grow">
        <div className="max-w-4xl mx-auto px-4 py-8"></div>
      </main>
    </div>
  );
}
