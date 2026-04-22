'use client';

import { Bot } from 'lucide-react';

type AgentIconPreviewProps = {
  iconKey?: string;
  size?: number;
};

export default function AgentIconPreview({ iconKey, size = 32 }: AgentIconPreviewProps) {
  if (iconKey) {
    const iconUrl = `/api/agent-icon?key=${encodeURIComponent(iconKey)}`;
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src={iconUrl}
        alt="Agent icon"
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className="bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size }}
    >
      <Bot className="text-white" style={{ width: size * 0.5, height: size * 0.5 }} />
    </div>
  );
}
