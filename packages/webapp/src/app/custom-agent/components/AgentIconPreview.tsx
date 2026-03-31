'use client';

import { useState, useEffect } from 'react';
import { Bot } from 'lucide-react';
import { getImageUrls } from '@/actions/image/action';

type AgentIconPreviewProps = {
  iconKey?: string;
  size?: number;
};

export default function AgentIconPreview({ iconKey, size = 32 }: AgentIconPreviewProps) {
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  useEffect(() => {
    if (iconKey) {
      getImageUrls({ keys: [iconKey] }).then((result) => {
        if (result?.data && result.data.length > 0) {
          setIconUrl(result.data[0].url);
        }
      });
    }
  }, [iconKey]);

  if (iconUrl) {
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
