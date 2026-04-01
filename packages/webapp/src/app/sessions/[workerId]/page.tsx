import {
  getAttachedImageKey,
  getConversationHistory,
  getCustomAgent,
  getLastReadAt,
  getPreferences,
  getSession,
  getSessions,
  getTodoList,
  getUnreadMap,
  noOpFiltering,
} from '@remote-swe-agents/agent-core/lib';
import SessionPageClient from './component/SessionPageClient';
import { MessageView } from './component/MessageList';
import { notFound } from 'next/navigation';
import { RefreshOnFocus } from '@/components/RefreshOnFocus';
import { extractUserMessage, formatMessage } from '@/lib/message-formatter';
import { getSession as getAuthSession } from '@/lib/auth';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BucketName } from '@remote-swe-agents/agent-core/aws';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SessionPage({ params }: PageProps<'/sessions/[workerId]'>) {
  const { workerId } = await params;
  const session = await getSession(workerId);
  if (!session) {
    notFound();
  }

  const preferences = await getPreferences();
  // Load conversation history from DynamoDB
  const { items: historyItems } = await getConversationHistory(workerId);
  const { messages: filteredMessages, items: filteredItems } = await noOpFiltering(historyItems);

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
          modelOverride: item.modelOverride,
        });
        break;
      }
      case 'eventTrigger': {
        const text = (message.content?.map((c) => c.text).filter((c) => c) ?? []).join('\n');
        const extracted = extractUserMessage(text);

        messages.push({
          id: `${item.SK}-${i}`,
          role: 'assistant',
          content: extracted,
          detail: (item as any).name,
          timestamp: new Date(parseInt(item.SK)),
          type: 'eventTrigger',
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

  // Get sessions list for sidebar
  const allSessions = await getSessions(100);

  // Get unread data
  const { userId } = await getAuthSession();
  const [unreadMap, lastReadAt] = await Promise.all([getUnreadMap(userId), getLastReadAt(userId, workerId)]);

  // Resolve agent icon URL
  let agentIconUrl: string | undefined;
  const customAgent = session.customAgentId ? await getCustomAgent(session.customAgentId) : undefined;
  const iconKey = customAgent?.iconKey || preferences.defaultAgentIconKey;
  if (iconKey) {
    try {
      agentIconUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BucketName, Key: iconKey }), {
        expiresIn: 3600,
      });
    } catch {
      // Ignore errors, fall back to default icon
    }
  }

  return (
    <>
      <SessionPageClient
        workerId={workerId}
        preferences={preferences}
        initialTitle={session.title}
        initialMessages={messages}
        initialInstanceStatus={session.instanceStatus}
        initialAgentStatus={session.agentStatus}
        initialTodoList={todoList}
        allSessions={allSessions}
        agentIconUrl={agentIconUrl}
        agentName={customAgent?.name || preferences.defaultAgentName || undefined}
        unreadMap={unreadMap}
        lastReadAt={lastReadAt}
      />
      <RefreshOnFocus />
    </>
  );
}
