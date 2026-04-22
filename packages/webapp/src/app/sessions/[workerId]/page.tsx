import {
  getAttachedImageKey,
  getAttachedFileKey,
  isImageKey,
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
import { extractUserMessage, formatMessage, stripAgentMessagePrefix } from '@/lib/message-formatter';
import { getSession as getAuthSession } from '@/lib/auth';

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
    ['sendMessageToUser', 'sendMessageToUserIfNecessary', 'sendImageToUser', 'sendFileToUser'].includes(toolName ?? '');
  const isHiddenTool = (toolName: string | undefined) =>
    isMsg(toolName) || ['sendMessageToAgent', 'acknowledgeAgent', 'confirmSendToUser'].includes(toolName ?? '');

  // Collect all completed toolUseIds from toolResult messages
  const completedToolUseIds = new Set<string>();
  for (const msg of filteredMessages) {
    for (const block of msg.content ?? []) {
      if (block.toolResult?.toolUseId) {
        completedToolUseIds.add(block.toolResult.toolUseId);
      }
    }
  }

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
            } else if (toolName === 'sendFileToUser') {
              const messageText = formatMessage(input?.message ?? '');
              const key = getAttachedFileKey(workerId, toolUseId, input.filePath);
              const isToolComplete = completedToolUseIds.has(toolUseId);

              // Extract reasoning content if available
              let reasoningText: string | undefined;
              const reasoningBlocks = message.content?.filter((block) => block.reasoningContent) ?? [];
              if (reasoningBlocks.length > 0) {
                reasoningText = reasoningBlocks[0].reasoningContent?.reasoningText?.text;
              }

              if (isImageKey(key)) {
                messages.push({
                  id: `${item.SK}-${i}-${toolUseId}`,
                  role: 'assistant',
                  content: messageText,
                  timestamp: new Date(parseInt(item.SK)),
                  type: 'message',
                  imageKeys: isToolComplete ? [key] : undefined,
                  thinkingBudget: item.thinkingBudget,
                  reasoningText,
                });
              } else {
                messages.push({
                  id: `${item.SK}-${i}-${toolUseId}`,
                  role: 'assistant',
                  content: messageText,
                  timestamp: new Date(parseInt(item.SK)),
                  type: 'message',
                  fileKeys: isToolComplete ? [key] : undefined,
                  thinkingBudget: item.thinkingBudget,
                  reasoningText,
                });
              }
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
          .filter((c) => !isHiddenTool(c.toolUse.name));

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

        // Extract image keys from user message content
        const userImageKeys = (message.content ?? [])
          .filter((c: any) => c.image?.source?.s3Key)
          .map((c: any) => c.image.source.s3Key as string);

        // Extract file keys from user message content
        const userFileKeys = (message.content ?? [])
          .filter((c: any) => c.file?.source?.s3Key)
          .map((c: any) => c.file.source.s3Key as string);

        messages.push({
          id: `${item.SK}-${i}`,
          role: 'user',
          content: extracted,
          timestamp: new Date(parseInt(item.SK)),
          type: 'message',
          modelOverride: item.modelOverride,
          ...(userImageKeys.length > 0 ? { imageKeys: userImageKeys } : {}),
          ...(userFileKeys.length > 0 ? { fileKeys: userFileKeys } : {}),
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
      case 'agentMessage': {
        const text = (message.content?.map((c) => c.text).filter((c) => c) ?? []).join('\n');
        const extracted = stripAgentMessagePrefix(extractUserMessage(text));

        messages.push({
          id: `${item.SK}-${i}`,
          role: 'user',
          content: extracted,
          timestamp: new Date(parseInt(item.SK)),
          type: 'agentMessage',
          senderSessionId: item.senderSessionId,
          senderAgentName: item.senderAgentName,
          targetSessionId: item.targetSessionId,
          targetAgentName: item.targetAgentName,
          isAcknowledge: item.isAcknowledge,
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

  // Resolve agent icon URL via /api/agent-icon route (cached by CloudFront)
  let agentIconUrl: string | undefined;
  const customAgent = session.customAgentId ? await getCustomAgent(session.customAgentId) : undefined;
  const iconKey = customAgent?.iconKey || preferences.defaultAgentIconKey;
  if (iconKey) {
    agentIconUrl = `/api/agent-icon?key=${encodeURIComponent(iconKey)}`;
  }

  return (
    <>
      <SessionPageClient
        workerId={workerId}
        userId={userId}
        preferences={preferences}
        initialTitle={session.title}
        initialMessages={messages}
        initialInstanceStatus={session.instanceStatus}
        initialAgentStatus={session.agentStatus}
        initialTodoList={todoList}
        allSessions={allSessions}
        agentIconUrl={agentIconUrl}
        agentName={session.agentName || customAgent?.name || preferences.defaultAgentName || undefined}
        unreadMap={unreadMap}
        lastReadAt={lastReadAt}
        parentSessionId={session.parentSessionId}
      />
      <RefreshOnFocus />
    </>
  );
}
