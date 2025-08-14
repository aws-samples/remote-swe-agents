import { ReactNode } from 'react';

interface PreferenceSectionProps {
  title: string;
  description: string;
  children: ReactNode;
}

export default function PreferenceSection({ title, description, children }: PreferenceSectionProps) {
  return (
    <div className="border border-gray-200 dark:border-gray-800 shadow-sm rounded-lg bg-white dark:bg-gray-800">
      <div className="p-6 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-xl font-semibold mb-1">{title}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>
      </div>

      <div className="p-6">{children}</div>
    </div>
  );
}
