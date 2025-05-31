import { getConversationHistory } from '@remote-swe-agents/agent-core/lib';
import SessionPageClient, { AgentMessage } from './component/SessionPageClient';

interface SessionPageProps {
  params: Promise<{
    workerId: string;
  }>;
}

export default async function SessionPage({ params }: SessionPageProps) {
  const { workerId } = await params;

  // Load conversation history from DynamoDB
  const { items: historyItems } = await getConversationHistory(workerId);

  // Convert history items to AgentMessage format
  const initialMessages: AgentMessage[] = historyItems.map((item, index) => {
    let content = '';

    try {
      if (typeof item.content === 'string') {
        const parsedContent = JSON.parse(item.content);
        if (Array.isArray(parsedContent)) {
          content = parsedContent.map((c: { text?: string }) => c.text || '').join('');
        }
      }
    } catch (error) {
      console.error('Error parsing message content:', error);
      content = typeof item.content === 'string' ? item.content : '';
    }

    return {
      id: `${item.SK}-${index}`,
      role: item.role as 'user' | 'assistant',
      content,
      timestamp: new Date(parseInt(item.SK)).toISOString(),
      type: item.messageType === 'toolUse' ? ('tool_use' as const) : ('message' as const),
    };
  });

  return (
    <SessionPageClient
      workerId={workerId}
      initialMessages={initialMessages}
    />
  );
}
