import React, { useState } from 'react';
import { ArrowRight, ArrowLeft, ChevronRight, ChevronDown, Bot } from 'lucide-react';
import { MessageView } from './MessageList';
import { MarkdownRenderer } from './MarkdownRenderer';

type AgentMessageRendererProps = {
  message: MessageView;
  /** The agent name of the currently open chat session */
  agentName?: string;
};

/**
 * Renders an agent-to-agent message with compact communication log style.
 *
 * Arrow direction indicates send/receive relative to the current session's agent:
 * - Current agent is target (receiving): CurrentAgent ← SenderAgent
 * - Current agent is sender (sending): CurrentAgent → TargetAgent
 * - Neither matches (e.g. parent watching): SenderAgent → TargetAgent
 */
export const AgentMessageRenderer = ({ message, agentName }: AgentMessageRendererProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const isAck = message.isAcknowledge;

  const isCurrentTarget = agentName && message.targetAgentName === agentName;
  const isCurrentSender = agentName && message.senderAgentName === agentName;

  let leftName: string;
  let rightName: string | undefined;
  let arrowDirection: '←' | '→';

  if (isCurrentTarget) {
    leftName = agentName;
    rightName = message.senderAgentName || 'Agent';
    arrowDirection = '←';
  } else if (isCurrentSender) {
    leftName = agentName;
    rightName = message.targetAgentName || 'Agent';
    arrowDirection = '→';
  } else {
    leftName = message.senderAgentName || 'Agent';
    rightName = message.targetAgentName;
    arrowDirection = '→';
  }

  const ArrowIcon = arrowDirection === '←' ? ArrowLeft : ArrowRight;

  return (
    <div className="rounded-md min-w-0 w-full overflow-hidden">
      <div className="flex items-start gap-2 min-w-0">
        <button onClick={() => setIsExpanded(!isExpanded)} className="flex-shrink-0 mt-0.5 cursor-pointer">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          )}
        </button>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setIsExpanded(!isExpanded)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsExpanded(!isExpanded);
            }
          }}
          className="flex-1 flex items-center text-left text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 cursor-pointer min-w-0 gap-2"
        >
          <Bot className="w-4 h-4 flex-shrink-0 text-blue-500" />
          <span className="font-medium text-sm truncate">{leftName}</span>
          {rightName ? (
            <>
              <ArrowIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="font-medium text-sm truncate">{rightName}</span>
              {isAck && <span className="text-xs text-green-600 dark:text-green-400 flex-shrink-0">(ack)</span>}
            </>
          ) : (
            <span className="text-sm text-gray-500 truncate">
              {message.content.length > 60 ? message.content.slice(0, 60) + '...' : message.content}
            </span>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className="ml-6 mt-2 p-3 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 overflow-x-auto max-w-full">
          <div className="text-sm text-gray-700 dark:text-gray-300 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all">
            <MarkdownRenderer content={message.content} />
          </div>
        </div>
      )}
    </div>
  );
};
