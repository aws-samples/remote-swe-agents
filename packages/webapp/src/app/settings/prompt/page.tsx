import Header from '@/components/Header';
import { readCommonPrompt } from '@remote-swe-agents/agent-core/lib';
import PromptForm from './components/PromptForm';

export default async function PromptSettingsPage() {
  // Get the current prompt directly in server component
  const promptData = await readCommonPrompt();
  const additionalSystemPrompt = promptData?.additionalSystemPrompt || '';

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">Common Prompt Settings</h1>
          <p className="text-gray-600 dark:text-gray-300">
            Configure a common prompt that will be added to all agent interactions
          </p>
        </div>

        <div className="border border-gray-200 dark:border-gray-800 shadow-sm rounded-lg bg-white dark:bg-gray-800">
          <div className="p-6 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-semibold mb-1">Agent Prompt Configuration</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              This prompt will be added to all agents' system prompt. Use this to set organization-wide guidelines or
              instructions.
            </p>
          </div>

          <div className="p-6">
            <PromptForm initialPrompt={additionalSystemPrompt} />
          </div>
        </div>
      </main>
    </div>
  );
}
