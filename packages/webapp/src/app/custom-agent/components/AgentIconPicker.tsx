'use client';

import { useTranslations } from 'next-intl';
import AgentIconUploader from '@/components/AgentIconUploader';
import { isPresetIconKey, presetIcons, PRESET_ICON_PREFIX } from '@/lib/agent-icon-presets';

type AgentIconPickerProps = {
  currentIconKey?: string;
  onIconKeyChange: (key: string) => void;
  disabled?: boolean;
};

export default function AgentIconPicker({ currentIconKey, onIconKeyChange, disabled }: AgentIconPickerProps) {
  const t = useTranslations('customAgent');

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <AgentIconUploader
        key={currentIconKey && isPresetIconKey(currentIconKey) ? 'preset-selected' : 'upload'}
        currentIconKey={currentIconKey && !isPresetIconKey(currentIconKey) ? currentIconKey : undefined}
        onIconKeyChange={onIconKeyChange}
        disabled={disabled}
      />
      <div className="h-10 border-l border-gray-200 dark:border-gray-700" />
      {presetIcons.map((preset) => {
        const key = `${PRESET_ICON_PREFIX}${preset.id}`;
        const selected = currentIconKey === key;
        return (
          <button
            key={preset.id}
            type="button"
            title={preset.label}
            aria-label={t('form.icon.presetAriaLabel', { label: preset.label })}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onIconKeyChange(key)}
            className={`rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
              selected ? 'ring-2 ring-offset-2 ring-blue-500 dark:ring-offset-gray-800' : 'opacity-70 hover:opacity-100'
            }`}
            style={{ width: 44, height: 44, backgroundColor: preset.color }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#ffffff"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ width: 22, height: 22 }}
            >
              {preset.paths.map((d) => (
                <path key={d} d={d} />
              ))}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
