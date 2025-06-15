import Header from '@/components/Header';
import { getApiKeys } from '@remote-swe-agents/agent-core/lib';
import { ApiKeyItem } from '@remote-swe-agents/agent-core/schema';
import { formatDistanceToNow } from 'date-fns';
import { getTranslations } from 'next-intl/server';
import ApiKeyClientActions from './components/ApiKeyClientActions';
import { AppOrigin } from '@/lib/origin';

export default async function ApiKeysPage() {
  const apiKeys = await getApiKeys();
  const t = await getTranslations('api_settings');
  const documentationT = await getTranslations('api_settings.documentation');

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />
      <main className="flex-grow">
        <div className="max-w-6xl mx-auto px-4 py-8">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
          </div>

          <ApiKeyClientActions apiKeys={apiKeys} />

          <div className="mt-8">
            <div className="rounded-lg border border-gray-200 bg-white text-gray-950 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-50">
              <div className="flex flex-col space-y-1.5 p-6">
                <h3 className="text-2xl font-semibold leading-none tracking-tight">{documentationT('title')}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{documentationT('desc')}</p>
              </div>
              <div className="p-6 pt-0">
                <div className="space-y-6">
                  <div>
                    <h3 className="text-lg font-medium mb-2">{documentationT('authentication')}</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">{documentationT('authDesc')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>X-API-KEY: YOUR_API_KEY</code>
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-lg font-medium mb-2">{documentationT('createSession')}</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">{documentationT('createSessionDesc')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`POST /api/sessions

{
  "message": "Your initial message to the agent"
}`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">{documentationT('createSessionReturns')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`{
  "workerId": "api-1234567890"
}`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-4 mb-2">{documentationT('exampleCurl')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`curl -X POST \\
  ${AppOrigin}/api/sessions \\
  -H "Content-Type: application/json" \\
  -H "X-API-KEY: YOUR_API_KEY" \\
  -d '{"message": "Create a React component for a user profile page"}'`}</code>
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-lg font-medium mb-2">{documentationT('sendMessage')}</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">{documentationT('sendMessageDesc')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`POST /api/sessions/:sessionId

{
  "message": "Your follow-up message to the agent"
}`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">{documentationT('sendMessageNote')}</p>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">{documentationT('sendMessageReturns')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`{
  "success": true
}`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-4 mb-2">{documentationT('exampleCurl')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`curl -X POST \\
  ${AppOrigin}/api/sessions/api-1234567890 \\
  -H "Content-Type: application/json" \\
  -H "X-API-KEY: YOUR_API_KEY" \\
  -d '{"message": "Add dark mode support to the component"}'`}</code>
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-lg font-medium mb-2">{documentationT('getSession')}</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">{documentationT('getSessionDesc')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`GET /api/sessions/:sessionId`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">{documentationT('getSessionReturns')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`{
  "agentStatus": "working" | "pending" | "completed",
  "instanceStatus": "starting" | "running" | "stopped" | "terminated",
  "sessionCost": 0.25,
  "messages": [
    {
      "role": "user" | "assistant",
      "content": "message content"
    }
  ]
}`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-4 mb-2">{documentationT('exampleCurl')}</p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`curl -X GET \\
  ${AppOrigin}/api/sessions/api-1234567890 \\
  -H "X-API-KEY: YOUR_API_KEY"`}</code>
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
