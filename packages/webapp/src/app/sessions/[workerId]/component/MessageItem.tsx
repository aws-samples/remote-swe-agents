import React, { useState } from 'react';
import { Copy, ThoughtBubble } from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';
import { toast } from 'sonner';
import { MessageView } from './MessageList';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolUseRenderer } from './ToolUseRenderer';
import { UrlRenderer } from './UrlRenderer';
import { ImageViewer } from './ImageViewer';

type MessageItemProps = {
  message: MessageView;
  showTimestamp: boolean;
};

export const MessageItem = ({ message, showTimestamp }: MessageItemProps) => {
  const t = useTranslations('sessions');
  const locale = useLocale();
  const localeForDate = locale === 'ja' ? 'ja-JP' : 'en-US';
  const [showReasoning, setShowReasoning] = useState(false);

  const copyMessageToClipboard = (content: string) => {
    navigator.clipboard
      .writeText(content)
      .then(() => {
        toast.success(t('copySuccess'));
      })
      .catch((err) => {
        console.error('Could not copy text: ', err);
        toast.error(t('copyFailed'));
      });
  };

  return (
    <div className="flex items-start gap-1 py-1">
      <div
        className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0 mt-1 md:block hidden"
        style={{ minWidth: '55px' }}
      >
        {showTimestamp &&
          new Date(message.timestamp).toLocaleTimeString(localeForDate, { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="flex-1">
        {message.type === 'toolUse' ? (
          <ToolUseRenderer
            content={message.content}
            input={message.detail}
            output={message.output}
            messageId={message.id}
          />
        ) : (
          <div className="text-gray-900 dark:text-white pb-2 break-all">
            <div className="flex items-start">
              <div className="flex-1">
                {message.role === 'user' ? (
                  <UrlRenderer content={message.content} />
                ) : (
                  <MarkdownRenderer content={message.content} />
                )}
                {message.imageKeys && message.imageKeys.length > 0 && <ImageViewer imageKeys={message.imageKeys} />}

                {message.reasoningText && (
                  <div className="mt-2">
                    <button
                      onClick={() => setShowReasoning(!showReasoning)}
                      className="flex items-center text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 mb-1"
                    >
                      <ThoughtBubble className="w-3.5 h-3.5 mr-1" />
                      {showReasoning ? t('hideThinking') || 'Hide thinking' : t('showThinking') || 'Show thinking'}
                    </button>
                    {showReasoning && (
                      <div className="mt-1 p-2 rounded-md bg-gray-100 dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
                        <MarkdownRenderer content={message.reasoningText} />
                      </div>
                    )}
                  </div>
                )}
              </div>
              {message.type === 'message' && message.role === 'assistant' && (
                <button
                  onClick={() => copyMessageToClipboard(message.content)}
                  className="ml-2 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 flex-shrink-0 hidden md:block"
                  title={t('copyMessage')}
                >
                  <Copy className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
