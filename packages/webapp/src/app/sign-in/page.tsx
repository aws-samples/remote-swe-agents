import Link from 'next/link';

export default function SignInPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">Remote SWE Agents</h2>
        <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-300">
          Streamline software development by interacting with AI agents
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white dark:bg-gray-800 py-8 px-4 shadow sm:rounded-lg sm:px-10 border border-gray-200 dark:border-gray-700">
          <div className="flex flex-col items-center">
            <p className="mb-6 text-center text-sm text-gray-600 dark:text-gray-300">
              Please sign in with your Cognito account to continue
            </p>

            <Link
              href="/api/auth/sign-in?lang=ja"
              className="w-full flex justify-center py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-gray-800"
              prefetch={false} // prevent CORS error
            >
              Sign in with Cognito
            </Link>
          </div>
        </div>
      </div>

      <footer className="mt-8 text-center text-sm text-gray-500 dark:text-gray-400">
        <p>© {new Date().getFullYear()} Remote SWE Agents. All rights reserved.</p>
      </footer>
    </div>
  );
}
