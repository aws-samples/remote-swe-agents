import { getConversationHistory, getSession, noOpFiltering } from '@remote-swe-agents/agent-core/lib';
import SessionPageClient from './component/SessionPageClient';
import { MessageView } from './component/MessageList';
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

  const messages: MessageView[] = [];
  const isMsg = (toolName: string | undefined) =>
    ['sendMessageToUser', 'sendMessageToUserIfNecessary'].includes(toolName ?? '');
  for (let i = 0; i < filteredMessages.length; i++) {
    const message = filteredMessages[i];
    const item = filteredItems[i];

    switch (item.messageType) {
      case 'toolUse': {
        const msgBlocks = message.content?.filter((block) => isMsg(block.toolUse?.name)) ?? [];

        if (msgBlocks.length > 0) {
          messages.push({
            id: `${item.SK}-${i}`,
            role: 'assistant',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content: (msgBlocks[0].toolUse?.input as any).message ?? '',
            timestamp: new Date(parseInt(item.SK)),
            type: 'message',
          });
        }

        const tools = (message.content ?? [])
          .filter((c) => c.toolUse != undefined)
          .filter((c) => !isMsg(c.toolUse.name));

        if (tools.length > 0) {
          const content = tools.map((block) => block.toolUse.name).join(' + ');
          const detail = tools
            .map(
              (block) =>
                `${block.toolUse.name} (${block.toolUse.toolUseId})\n${JSON.stringify(block.toolUse.input, undefined, 2)}`
            )
            .join('\n\n');

          messages.push({
            id: `${item.SK}-${i}`,
            role: 'assistant',
            content,
            detail,
            timestamp: new Date(parseInt(item.SK)),
            type: 'toolUse',
          });
        }
        break;
      }
      case 'toolResult': {
        // the corresponding toolUse message should exist in the element right before.
        const toolUse = messages.at(-1);
        if (!toolUse || toolUse.type != 'toolUse') break;

        const results = (message.content ?? []).filter((c) => c.toolResult != undefined);

        if (results.length > 0) {
          console.log('toolResult set');
          const detail = results
            .map(
              (block) =>
                `${block.toolResult.toolUseId}\n${(block.toolResult.content ?? [])
                  .filter((b) => b.text)
                  .map((b) => b.text)
                  .join('\n')}`
            )
            .join('\n\n');
          toolUse.output = detail;
        }
        break;
      }
      case 'userMessage': {
        const text = (message.content?.map((c) => c.text).filter((c) => c) ?? []).join('\n');
        const extracted = text
          .slice(text.indexOf('<user_message>') + '<user_message>'.length, text.indexOf('</user_message>'))
          .trim();

        messages.push({
          id: `${item.SK}-${i}`,
          role: 'user',
          content: extracted,
          timestamp: new Date(parseInt(item.SK)),
          type: 'message',
        });
        break;
      }
      case 'assistant': {
        const text = (message.content?.map((c) => c.text).filter((c) => c) ?? []).join('\n');

        messages.push({
          id: `${item.SK}-${i}`,
          role: 'assistant',
          content: text,
          timestamp: new Date(parseInt(item.SK)),
          type: 'message',
        });
        break;
      }
    }
  }

  return (
    <SessionPageClient workerId={workerId} initialMessages={messages} initialInstanceStatus={session.instanceStatus} />
  );
}
