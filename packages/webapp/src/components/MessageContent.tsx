'use client';

import React from 'react';
import { removeSlackMentions } from '@/utils/message-formatter';

/**
 * A component that filters Slack mention strings from message content
 * If the resulting content is empty after filtering, nothing is rendered
 */
interface MessageContentProps {
  content: string;
  render: (content: string) => React.ReactNode;
}

export function MessageContent({ content, render }: MessageContentProps) {
  // Filter out Slack mentions
  const cleanedContent = removeSlackMentions(content);
  
  // If content is null/empty after filtering, don't render anything
  if (!cleanedContent) return null;
  
  // Otherwise, render the content using the provided render function
  return <>{render(cleanedContent)}</>;
}