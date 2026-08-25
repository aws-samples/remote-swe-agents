'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import type { Skill } from '@remote-swe-agents/agent-core/schema';
import { deleteSkill } from '@/actions/skill/action';
import LocalDateTime from '@/components/LocalDateTime';

type SkillListProps = {
  initialSkills: Skill[];
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SkillList({ initialSkills }: SkillListProps) {
  const t = useTranslations('skills');
  const [skills, setSkills] = useState(initialSkills);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (skills.length === 0) {
    return <p className="text-gray-500 dark:text-gray-400">{t('noSkills')}</p>;
  }

  const handleDelete = async (skill: Skill) => {
    if (!confirm(t('confirmDelete'))) return;
    setDeletingId(skill.SK);
    try {
      const result = await deleteSkill({ skillId: skill.SK });
      if (result?.data?.success) {
        setSkills((prev) => prev.filter((s) => s.SK !== skill.SK));
      }
    } catch {
      alert(t('deleteError'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-3">
      {skills.map((skill) => (
        <div
          key={skill.SK}
          className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
        >
          <div
            className="p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
            onClick={() => setExpandedId(expandedId === skill.SK ? null : skill.SK)}
          >
            <div className="flex justify-between items-start">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-semibold">{skill.name}</h3>
                  <span className="px-2 py-0.5 text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded">
                    {formatBytes(skill.totalSize)}
                  </span>
                  <span className="px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
                    {skill.fileCount} {t('files')}
                  </span>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 truncate">{skill.description}</p>
              </div>
              <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  <LocalDateTime timestamp={skill.updatedAt} format="date" />
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(skill);
                  }}
                  disabled={deletingId === skill.SK}
                  className="p-1 text-red-500 hover:text-red-700 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                {expandedId === skill.SK ? (
                  <ChevronUp className="h-4 w-4 text-gray-500" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-gray-500" />
                )}
              </div>
            </div>
          </div>
          {expandedId === skill.SK && (
            <div className="border-t border-gray-200 dark:border-gray-700 p-4">
              <div className="text-sm space-y-1">
                <p>
                  <span className="font-medium">ID:</span> {skill.SK}
                </p>
                {skill.allowedTools && skill.allowedTools.length > 0 && (
                  <p>
                    <span className="font-medium">Allowed Tools:</span> {skill.allowedTools.join(', ')}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
