import { getConversationHistory, getSession, noOpFiltering } from '@remote-swe-agents/agent-core/lib';
import SessionPageClient from './component/SessionPageClient';
import { Message } from './component/MessageList';
import { notFound } from 'next/navigation';

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

  // Get session info including instance status
  const session = await getSession(workerId);

  if (!session) {
    notFound();
  }

  const messages: Message[] = filteredMessages.flatMap<Message>((message, i) => {
    const item = filteredItems[i];
    switch (item.messageType) {
      case 'toolUse': {
        const ret: Message[] = [];
        const isMsg = (toolName: string | undefined) =>
          ['sendMessageToUser', 'sendMessageToUserIfNecessary'].includes(toolName ?? '');
        const messages = message.content?.filter((block) => isMsg(block.toolUse?.name)) ?? [];
        if (messages && messages.length > 0) {
          ret.push({
            id: `${item.SK}-${i}`,
            role: 'assistant',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content: (messages[0].toolUse?.input as any).message ?? '',
            timestamp: new Date(parseInt(item.SK)),
            type: 'message',
          });
        }

        const tools = (message.content ?? []).filter((c) => c.toolUse?.name != undefined && !isMsg(c.toolUse.name));
        const content = tools.map((block) => block.toolUse?.name).join(' + ');
        const detail = tools
          .map((block) => `${block.toolUse?.name}\n${JSON.stringify(block.toolUse?.input, undefined, 2)}`)
          .join('\n\n');
        if (tools && tools.length > 0) {
          ret.push({
            id: `${item.SK}-${i}`,
            role: 'assistant',
            content,
            detail,
            timestamp: new Date(parseInt(item.SK)),
            type: 'toolUse',
          });
        }
        return ret;
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

  return (
    <SessionPageClient workerId={workerId} initialMessages={messages} initialInstanceStatus={session.instanceStatus} />
  );
}
