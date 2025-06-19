import Header from '@/components/Header';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import NewSessionForm from './NewSessionForm';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PromptTemplate } from '@/app/sessions/new/schemas';

export default async function NewSessionPage() {
  const t = await getTranslations('new_session');
  const sessionsT = await getTranslations('sessions');

  // Fetch templates directly from DynamoDB
  let templates: PromptTemplate[] = [];
  const result = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'prompt-template',
      },
      ScanIndexForward: false, // Sort by SK (createdAt) in descending order
    })
  );

  templates = (result.Items ?? []) as PromptTemplate[];

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow pt-20">
        <div className="max-w-2xl mx-auto px-4 py-8">
          <div className="mb-6">
            <Link
              href="/sessions"
              className="inline-flex items-center gap-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white mb-4"
            >
              <ArrowLeft className="w-4 h-4" />
              {sessionsT('backToSessions')}
            </Link>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
          </div>

          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8">
            <div className="text-center">
              <MessageSquare className="w-16 h-16 text-blue-600 dark:text-blue-400 mx-auto mb-6" />
              <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">{t('heading')}</h2>
              <p className="text-gray-600 dark:text-gray-300 mb-8">{t('description')}</p>

              <div className="space-y-4">
                <div className="text-left bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-white">{t('whatYouCanDo')}</h3>
                  <ul className="text-sm text-gray-600 dark:text-gray-300 space-y-1">
                    <li>• {t('features.code')}</li>
                    <li>• {t('features.file')}</li>
                    <li>• {t('features.command')}</li>
                    <li>• {t('features.github')}</li>
                    <li>• {t('features.monitoring')}</li>
                  </ul>
                </div>

                <NewSessionForm templates={templates} />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
