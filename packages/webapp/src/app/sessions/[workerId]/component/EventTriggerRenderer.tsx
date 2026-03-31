import React, { useState } from 'react';
import { Bell, ChevronRight, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

type EventTriggerRendererProps = {
  name?: string;
  content: string;
};

export const EventTriggerRenderer = ({ name, content }: EventTriggerRendererProps) => {
  const t = useTranslations('sessions');
  const [isExpanded, setIsExpanded] = useState(false);

  const displayName = name || content.split('\n')[0];

  // Try to parse event details from the content
  let eventDetails: string | undefined;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      eventDetails = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Not JSON, use raw content
  }

  return (
    <div className="rounded-md min-w-0">
      <div className="flex items-start gap-2 min-w-0">
        <button onClick={() => setIsExpanded(!isExpanded)} className="flex-shrink-0 mt-0.5">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          )}
        </button>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex-1 flex items-start text-left text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 cursor-pointer hover:underline min-w-0"
        >
          <span className="mt-0.5 flex-shrink-0 mr-2">
            <Bell className="w-4 h-4" />
          </span>
          <span className="min-w-0 truncate block">
            <span>{t('eventTriggerFired')}: </span>
            {displayName}
          </span>
        </button>
      </div>

      {isExpanded && (
        <div className="mt-2 ml-6 space-y-2">
          <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded overflow-auto max-h-60">
            <pre className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-all">
              {eventDetails || content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
