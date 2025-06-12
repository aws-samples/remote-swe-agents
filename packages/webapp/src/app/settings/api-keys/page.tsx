import Header from '@/components/Header';
import { getApiKeys } from '@remote-swe-agents/agent-core/lib';
import { ApiKeyItem } from '@remote-swe-agents/agent-core/schema';
import { formatDistanceToNow } from 'date-fns';
import { getTranslations } from 'next-intl/server';
import ApiKeyClientActions from './components/ApiKeyClientActions';

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
            {/* Client components will handle refresh button */}
          </div>

          <div className="mb-8">
            <div className="rounded-lg border border-gray-200 bg-white text-gray-950 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-50">
              <div className="flex flex-col space-y-1.5 p-6">
                <h3 className="text-2xl font-semibold leading-none tracking-tight">{t('createNew')}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('createDesc')}</p>
              </div>
              <div className="p-6 pt-0">
                <ApiKeyClientActions apiKeys={apiKeys} />
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white text-gray-950 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-50">
            <div className="flex flex-col space-y-1.5 p-6">
              <h3 className="text-2xl font-semibold leading-none tracking-tight">{t('yourKeys')}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('yourKeysDesc')}</p>
            </div>
            <div className="p-6 pt-0">
              <div className="space-y-4">
                {(!apiKeys || apiKeys.length === 0) && (
                  <p className="text-gray-500 dark:text-gray-400 text-center py-4">
                    {t('noKeys')}
                  </p>
                )}
                {apiKeys.map((key: ApiKeyItem) => (
                  <div
                    key={key.SK}
                    className="p-4 border border-gray-200 dark:border-gray-800 rounded-md flex justify-between items-center"
                  >
                    <div>
                      <div className="text-sm font-medium">{key.description || t('unnamedKey')}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {t('createdAgo', { timeAgo: formatDistanceToNow(new Date(key.createdAt), { addSuffix: true }) })}
                      </div>
                    </div>
                    {/* Delete button will be handled by client component */}
                  </div>
                ))}
              </div>
            </div>
          </div>

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
                    <p className="text-gray-600 dark:text-gray-300 mb-2">
                      {documentationT('authDesc')}
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>Authorization: Bearer YOUR_API_KEY</code>
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-lg font-medium mb-2">{documentationT('createSession')}</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">
                      {documentationT('createSessionDesc')}
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`POST /api/sessions/

{
  "message": "Your initial message to the agent"
}`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">
                      {documentationT('createSessionReturns')}
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`{
  "workerId": "api-1234567890"
}`}</code>
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-lg font-medium mb-2">{documentationT('sendMessage')}</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">
                      {documentationT('sendMessageDesc')}
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`POST /api/sessions/:sessionId

{
  "message": "Your follow-up message to the agent"
}`}</code>
                    </pre>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">
                      {documentationT('sendMessageNote')}
                    </p>
                    <p className="text-gray-600 dark:text-gray-300 mt-2">
                      {documentationT('sendMessageReturns')}
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`{
  "success": true
}`}</code>
                    </pre>
                  </div>

                  <div>
                    <h3 className="text-lg font-medium mb-2">{documentationT('examples')}</h3>
                    <p className="text-gray-600 dark:text-gray-300 mb-2">
                      {documentationT('exampleCreateSession')}
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`curl -X POST \\
  https://yourwebapp.com/api/sessions/ \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"message": "Create a React component for a user profile page"}'`}</code>
                    </pre>

                    <p className="text-gray-600 dark:text-gray-300 mt-4 mb-2">
                      {documentationT('exampleSendMessage')}
                    </p>
                    <pre className="p-4 bg-gray-100 dark:bg-gray-800 rounded-md overflow-x-auto">
                      <code>{`curl -X POST \\
  https://yourwebapp.com/api/sessions/api-1234567890 \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{"message": "Add dark mode support to the component"}'`}</code>
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
