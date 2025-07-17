import {
  getAttachedImageKey,
  getConversationHistory,
  getSession,
  getTodoList,
  noOpFiltering,
} from '@remote-swe-agents/agent-core/lib';
import SessionPageClient from './component/SessionPageClient';
import { MessageView } from './component/MessageList';
import { notFound } from 'next/navigation';
import { RefreshOnFocus } from '@/components/RefreshOnFocus';
import { extractUserMessage, formatMessage } from '@/lib/message-formatter';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
    ['sendMessageToUser', 'sendMessageToUserIfNecessary', 'sendImageToUser'].includes(toolName ?? '');
  for (let i = 0; i < filteredMessages.length; i++) {
    const message = filteredMessages[i];
    const item = filteredItems[i];

    switch (item.messageType) {
      case 'toolUse': {
        const msgBlocks = message.content?.filter((block) => isMsg(block.toolUse?.name)) ?? [];

        if (msgBlocks.length > 0) {
          for (const block of msgBlocks) {
            const toolName = block.toolUse!.name;
            const toolUseId = block.toolUse!.toolUseId!;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const input = block.toolUse?.input as any;

            if (toolName === 'sendImageToUser') {
              const messageText = formatMessage(input?.message ?? '');
              const key = getAttachedImageKey(workerId, toolUseId, input.imagePath);

              // Extract reasoning content if available
              let reasoningText: string | undefined;
              const reasoningBlocks = message.content?.filter((block) => block.reasoningContent) ?? [];
              if (reasoningBlocks.length > 0) {
                reasoningText = reasoningBlocks[0].reasoningContent?.reasoningText?.text;
              }

              messages.push({
                id: `${item.SK}-${i}-${toolUseId}`,
                role: 'assistant',
                content: messageText,
                timestamp: new Date(parseInt(item.SK)),
                type: 'message',
                imageKeys: [key],
                thinkingBudget: item.thinkingBudget,
                reasoningText,
              });
            } else {
              // Handle sendMessageToUser and sendMessageToUserIfNecessary as before
              const messageText = formatMessage(input?.message ?? '');

              // Extract reasoning content if available
              let reasoningText: string | undefined;
              const reasoningBlocks = message.content?.filter((block) => block.reasoningContent) ?? [];
              if (reasoningBlocks.length > 0) {
                reasoningText = reasoningBlocks[0].reasoningContent?.reasoningText?.text;
              }

              if (messageText) {
                messages.push({
                  id: `${item.SK}-${i}-${toolUseId}`,
                  role: 'assistant',
                  content: messageText,
                  timestamp: new Date(parseInt(item.SK)),
                  type: 'message',
                  thinkingBudget: item.thinkingBudget,
                  reasoningText,
                });
              }
            }
          }
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
            thinkingBudget: item.thinkingBudget,
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
        const extracted = extractUserMessage(text);

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
        const formatted = formatMessage(text);

        // Extract reasoning content if available
        let reasoningText: string | undefined;
        const reasoningBlocks = message.content?.filter((block) => block.reasoningContent) ?? [];
        if (reasoningBlocks.length > 0) {
          reasoningText = reasoningBlocks[0].reasoningContent?.reasoningText?.text;
        }

        if (formatted) {
          messages.push({
            id: `${item.SK}-${i}`,
            role: 'assistant',
            content: text,
            timestamp: new Date(parseInt(item.SK)),
            type: 'message',
            thinkingBudget: item.thinkingBudget,
            reasoningText,
          });
        }
        break;
      }
    }
  }

  // Get todo list for this session
  const todoList = await getTodoList(workerId);

  return (
    <>
      <SessionPageClient
        workerId={workerId}
        initialMessages={messages}
        initialInstanceStatus={session.instanceStatus}
        initialAgentStatus={session.agentStatus}
        initialTodoList={todoList}
      />
      <RefreshOnFocus />
    </>
  );
}
