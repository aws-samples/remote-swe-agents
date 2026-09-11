'use client';

import { Bot } from 'lucide-react';
import { getPresetIcon, isPresetIconKey } from '@/lib/agent-icon-presets';

type AgentIconPreviewProps = {
  iconKey?: string;
  size?: number;
};

export default function AgentIconPreview({ iconKey, size = 32 }: AgentIconPreviewProps) {
  if (iconKey && isPresetIconKey(iconKey)) {
    const preset = getPresetIcon(iconKey);
    if (preset) {
      return (
        <div
          className="rounded-full flex items-center justify-center flex-shrink-0"
          style={{ width: size, height: size, backgroundColor: preset.color }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ width: size * 0.5, height: size * 0.5 }}
          >
            {preset.paths.map((d) => (
              <path key={d} d={d} />
            ))}
          </svg>
        </div>
      );
    }
  }

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
