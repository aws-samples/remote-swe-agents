import {
  getAttachedImageKey,
  isImageKey,
  getConversationHistory,
  getCustomAgent,
  getLastReadAt,
  getPreferences,
  getSession,
  getAllSessionsIncludingChildren,
  getTodoList,
  getUnreadMap,
  noOpFiltering,
  parseAttachmentSentinel,
  readMetadata,
  resolveModelConfig,
  isEndOfTurnPlaceholder,
  isScaffoldingArtifact,
  applyRewindFilter,
  countRewoundMessages,
  MSG_TOOLS,
} from '@remote-swe-agents/agent-core/lib';
import { toolNameInSet } from '@remote-swe-agents/agent-core/tool-name-utils';
import SessionPageClient from './component/SessionPageClient';
import { MessageView } from './component/MessageList';
import { notFound } from 'next/navigation';
import { RefreshOnFocus } from '@/components/RefreshOnFocus';
import { extractUserMessage, formatMessage, stripAgentMessagePrefix, stripSenderPrefix } from '@/lib/message-formatter';
import { getSession as getAuthSession } from '@/lib/auth';
import { toSessionListItems } from '@/lib/session-list';
import type { PortMapping } from '@/lib/port-url-transform';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SessionPage({ params }: { params: Promise<{ workerId: string }> }) {
  const { workerId } = await params;
  const session = await getSession(workerId);
  if (!session) {
    notFound();
  }

  const preferences = await getPreferences();
  // Load conversation history from DynamoDB.
  // Use `includeAll: true` so sibling-to-sibling agent communication logs
  // (messageType === 'communicationLog') are included in the UI view.
  // Pass `forUi: true` to `noOpFiltering` so attachment blocks
  // (`image.source.s3Key`, `file.source.s3Key`) are returned verbatim — the
  // webapp resolves them to pre-signed URLs client-side. The default LLM
  // path would otherwise download every referenced object into the Lambda
  // heap, which OOMs for multi-GB attachments and silently truncates the
  // SSR response (browsers report `ERR_CONTENT_DECODING_FAILED`).
  const { items: historyItems } = await getConversationHistory(workerId, { includeAll: true });
  const rewindedCount = countRewoundMessages(historyItems, session.rewindState);
  const visibleItems = applyRewindFilter(historyItems, session.rewindState);
  const { messages: filteredMessages, items: filteredItems } = await noOpFiltering(visibleItems, { forUi: true });

  const messages: MessageView[] = [];
  const isMsg = (toolName: string | undefined) => toolNameInSet(toolName ?? '', MSG_TOOLS);
  const HIDDEN_AGENT_TOOLS = new Set([
    'sendMessageToAgent',
    'acknowledgeAgent',
    'confirmSendToUser',
    'confirmCompleteSession',
    'Send Message To Agent',
    'Acknowledge Agent',
    'Confirm Send To User',
    'Confirm Complete Session',
  ]);
  const SEND_IMAGE_TOOLS = new Set(['sendImageToUser', 'Send Image To User']);
  const SEND_FILE_TOOLS = new Set(['sendFileToUser', 'Send File To User']);
  const isHiddenTool = (toolName: string | undefined) =>
    isMsg(toolName) || toolNameInSet(toolName ?? '', HIDDEN_AGENT_TOOLS);

  // Collect all completed toolUseIds from toolResult messages, and capture
  // the textual output for each so we can recover backend-provided metadata
  // (e.g. the `sendFileToUser` attachment sentinel carrying the canonical
  // S3 key — see `buildAttachmentSentinel` in agent-core).
  const completedToolUseIds = new Set<string>();
  const toolResultTextById = new Map<string, string>();
  for (const msg of filteredMessages) {
    for (const block of msg.content ?? []) {
      const tr = block.toolResult;
      if (!tr?.toolUseId) continue;
      completedToolUseIds.add(tr.toolUseId);
      const text = (tr.content ?? [])
        .map((c) => (typeof c === 'object' && c && 'text' in c ? (c as { text?: string }).text : undefined))
        .filter((t): t is string => typeof t === 'string')
        .join('\n');
      if (text) toolResultTextById.set(tr.toolUseId, text);
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
            const input = block.toolUse?.input as any;

            if (toolNameInSet(toolName ?? '', SEND_IMAGE_TOOLS)) {
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
            } else if (toolNameInSet(toolName ?? '', SEND_FILE_TOOLS)) {
              const messageText = formatMessage(input?.message ?? '');
              const isToolComplete = completedToolUseIds.has(toolUseId);
              // The backend embeds a `<!--remote-swe-attachment:...-->` sentinel
              // in the toolResult text carrying the canonical S3 key and
              // image flag. Parsing this avoids having to re-derive the key
              // from `context.toolUseId`, which is unreliable for kiro-cli
              // sessions where the MCP server falls back to `randomUUID()`.
              const sentinel = parseAttachmentSentinel(toolResultTextById.get(toolUseId));

              // Extract reasoning content if available
              let reasoningText: string | undefined;
              const reasoningBlocks = message.content?.filter((block) => block.reasoningContent) ?? [];
              if (reasoningBlocks.length > 0) {
                reasoningText = reasoningBlocks[0].reasoningContent?.reasoningText?.text;
              }

              const attachmentKey = sentinel?.key;
              const attachmentIsImage = sentinel?.isImage ?? (attachmentKey ? isImageKey(attachmentKey) : false);

              messages.push({
                id: `${item.SK}-${i}-${toolUseId}`,
                role: 'assistant',
                content: messageText,
                timestamp: new Date(parseInt(item.SK)),
                type: 'message',
                ...(isToolComplete && attachmentKey
                  ? attachmentIsImage
                    ? { imageKeys: [attachmentKey] }
                    : { fileKeys: [attachmentKey] }
                  : {}),
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

          const toolResultImageKeys = results
            .flatMap((block) => block.toolResult.content ?? [])
            .filter((b: any) => b.image?.source?.s3Key)
            .map((b: any) => b.image.source.s3Key as string);
          if (toolResultImageKeys.length > 0) {
            toolUse.imageKeys = [...(toolUse.imageKeys ?? []), ...toolResultImageKeys];
          }
        }
        break;
      }
      case 'userMessage': {
        const text = (message.content?.map((c) => c.text).filter((c) => c) ?? []).join('\n');
        // Strip the envelope tags first (`extractUserMessage`) and then the
        // `[from: ... (webapp|slack)]` sender prefix. The prefix exists for
        // LLM-side sender attribution only; the UI renders the sender name
        // separately via `userSenderDisplayName` so showing the literal
        // `[from: ...]` line inside the bubble was flagged as redundant
        // during E2E.
        const extracted = stripSenderPrefix(extractUserMessage(text));

        // Extract image keys from user message content
        const userImageKeys = (message.content ?? [])
          .filter((c: any) => c.image?.source?.s3Key)
          .map((c: any) => c.image.source.s3Key as string);

        // Extract file keys from user message content
        const userFileKeys = (message.content ?? [])
          .filter((c: any) => c.file?.source?.s3Key)
          .map((c: any) => c.file.source.s3Key as string);

        // Derive sender info for the UI. Priority:
        //   1. explicit `senderDisplayName` persisted on the item
        //   2. for Slack messages without a resolved display name, fall back
        //      to `<@slackUserId>` so viewers still see a hint of who wrote
        //      it (rather than the generic "User").
        // Older messages persisted before this feature have neither and
        // correctly fall back to "User" via MessageGroup's default.
        const userSenderType: 'slack' | 'webapp' | 'apikey' | undefined =
          (item as any).senderType ?? ((item as any).slackUserId ? 'slack' : undefined);
        const userSenderDisplayName =
          (item as any).senderDisplayName ??
          ((item as any).slackUserId ? `<@${(item as any).slackUserId}>` : undefined);
        const userSenderUserId: string | undefined =
          (item as any).senderUserId ?? (item as any).slackUserId ?? undefined;

        messages.push({
          id: `${item.SK}-${i}`,
          role: 'user',
          content: extracted,
          timestamp: new Date(parseInt(item.SK)),
          type: 'message',
          modelOverride: item.modelOverride,
          ...(userImageKeys.length > 0 ? { imageKeys: userImageKeys } : {}),
          ...(userFileKeys.length > 0 ? { fileKeys: userFileKeys } : {}),
          ...(userSenderDisplayName ? { userSenderDisplayName } : {}),
          ...(userSenderType ? { userSenderType } : {}),
          ...(userSenderUserId ? { userSenderUserId } : {}),
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
      case 'agentMessage':
      case 'communicationLog': {
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

        if (formatted && !isEndOfTurnPlaceholder(formatted) && !isScaffoldingArtifact(formatted)) {
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
      case 'assistantRejected':
      case 'mermaidFeedback':
        // Rejected assistant messages (failed mermaid validation) and their
        // feedback are internal retry artifacts — never render them.
        break;
    }
  }

  // Get todo list for this session
  const todoList = await getTodoList(workerId);

  // Get sessions list for sidebar (trimmed: the sidebar never renders full
  // initialMessage bodies, and shipping them bloats the RSC payload)
  const allSessions = toSessionListItems(await getAllSessionsIncludingChildren());

  // Get unread data
  const { userId, displayName: currentUserDisplayName } = await getAuthSession();
  const [unreadMap, lastReadAt] = await Promise.all([getUnreadMap(userId), getLastReadAt(userId, workerId)]);

  // Resolve agent icon URL via /api/agent-icon route (cached by CloudFront)
  let agentIconUrl: string | undefined;
  const customAgent = session.customAgentId ? await getCustomAgent(session.customAgentId) : undefined;
  const iconKey = customAgent?.iconKey || preferences.defaultAgentIconKey;
  if (iconKey) {
    agentIconUrl = `/api/agent-icon?key=${encodeURIComponent(iconKey)}`;
  }

  // Resolve the *effective* inference mode for this session using the same
  // priority chain the worker uses: session > customAgent > env > default.
  // We do this server-side so the initial render already reflects the
  // correct UI (Bedrock selector vs. Kiro model selector) — avoiding a
  // client-side flicker and potential hydration mismatch.
  //
  // User preferences are DELIBERATELY not consulted here. They are only
  // the default used at session creation time; flipping them must not
  // retroactively reinterpret existing / legacy sessions. Sessions created
  // before `inferenceMode` was persisted therefore fall through to
  // Bedrock, matching the single-backend world they originally ran in.
  const resolvedModel = resolveModelConfig({
    session: {
      inferenceMode: session.inferenceMode,
      bedrockDefaultModel: session.bedrockDefaultModel,
      kiroDefaultModel: session.kiroDefaultModel,
      kiroModel: session.kiroModel,
    },
    customAgent: customAgent
      ? {
          inferenceMode: customAgent.inferenceMode,
          bedrockDefaultModel: customAgent.bedrockDefaultModel,
          defaultModel: customAgent.defaultModel,
          kiroDefaultModel: customAgent.kiroDefaultModel,
          kiroModel: customAgent.kiroModel,
        }
      : undefined,
    env: { inferenceMode: process.env.INFERENCE_MODE },
  });
  const effectiveInferenceMode = resolvedModel.inferenceMode;
  const effectiveKiroModel = effectiveInferenceMode === 'kiro-cli' ? resolvedModel.kiroModel : undefined;
  const effectiveBedrockModel = resolvedModel.bedrockModel;

  // Load persisted port mappings (hostname + opened ports) so message
  // rendering can rewrite localhost:PORT links to the public EC2 URL. Only
  // present for EC2-runtime sessions where `openPort` has been invoked.
  // Also checks for MicroVM preview sessions (previewSession metadata).
  const rawPortMetadata = (await readMetadata('openedPorts', workerId)) as PortMapping | undefined;
  const rawPreviewMetadata = (await readMetadata('previewSession', workerId)) as
    | { previewUrl?: string; localPort?: number; startedAt?: number }
    | undefined;
  let initialPortMapping: PortMapping | null = null;
  if (rawPreviewMetadata?.previewUrl && rawPreviewMetadata?.localPort) {
    initialPortMapping = {
      previewBaseUrl: rawPreviewMetadata.previewUrl,
      openedPorts: [
        {
          fromPort: rawPreviewMetadata.localPort,
          toPort: rawPreviewMetadata.localPort,
          cidr: '*',
          // Server component, rendered once per request; Date.now() is a
          // legitimate fallback for a missing persisted start time.
          // eslint-disable-next-line react-hooks/purity
          openedAt: rawPreviewMetadata.startedAt ?? Date.now(),
        },
      ],
    };
  } else if (rawPortMetadata) {
    initialPortMapping = {
      hostname: rawPortMetadata.hostname,
      openedPorts: Array.isArray(rawPortMetadata.openedPorts) ? rawPortMetadata.openedPorts : [],
    };
  }

  return (
    <>
      <SessionPageClient
        workerId={workerId}
        userId={userId}
        currentUserDisplayName={currentUserDisplayName}
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
        inferenceMode={effectiveInferenceMode}
        kiroModel={effectiveKiroModel}
        bedrockModel={effectiveBedrockModel}
        sessionBedrockDefaultModel={session.bedrockDefaultModel}
        initialPortMapping={initialPortMapping}
        initialRewindHiddenCount={rewindedCount}
      />
      <RefreshOnFocus />
    </>
  );
}
