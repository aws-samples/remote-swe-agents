import { getConversationHistory, noOpFiltering } from '@remote-swe-agents/agent-core/lib';
import SessionPageClient from './component/SessionPageClient';
import { Message } from './component/MessageList';

interface SessionPageProps {
  params: Promise<{
    workerId: string;
  }>;
}

export default async function SessionPage({ params }: SessionPageProps) {
  const { workerId } = await params;

  // Load conversation history from DynamoDB
  const { items: historyItems } = await getConversationHistory(workerId);
  const { messages: filteredMessages, items: filteredItems } = await noOpFiltering(historyItems);
  console.log(historyItems);
  console.log(filteredMessages);
  const messages: Message[] = filteredMessages.flatMap<Message>((message, i) => {
    const item = filteredItems[i];
    switch (item.messageType) {
      case 'toolUse': {
        const tools = message.content?.map((block) => block.toolUse?.name).filter((n) => n != undefined);
        if (tools) {
          return [
            {
              id: `${item.SK}-${i}`,
              role: 'assistant',
              content: tools.join(' + '),
              timestamp: new Date(parseInt(item.SK)),
              type: 'toolUse',
            },
          ];
        }
        break;
      }
      case 'toolResult': {
        return [];
        return [
          {
            id: `${item.SK}-${i}`,
            role: 'assistant',
            content: 'toolResult',
            timestamp: new Date(parseInt(item.SK)),
            type: 'toolResult',
          },
        ];
      }
      case 'userMessage': {
        const text = (message.content?.map((c) => c.text).filter((c) => c) ?? []).join('\n');
        const extracted = text
          .slice(text.indexOf('<user_message>') + '<user_message>'.length, text.indexOf('</user_message>'))
          .trim();
        return [
          {
            id: `${item.SK}-${i}`,
            role: 'user',
            content: extracted,
            timestamp: new Date(parseInt(item.SK)),
            type: 'message',
          },
        ];
      }
      case 'assistant': {
        const text = (message.content?.map((c) => c.text).filter((c) => c) ?? []).join('\n');
        return [
          {
            id: `${item.SK}-${i}`,
            role: 'assistant',
            content: text,
            timestamp: new Date(parseInt(item.SK)),
            type: 'message',
          },
        ];
      }
    }
    return [];
  });

  return <SessionPageClient workerId={workerId} initialMessages={messages} />;
}
