'use client';

import React, { useState } from 'react';
import { TodoItem, TodoList as TodoListType } from '@remote-swe-agents/agent-core/schema';
import { ChevronDown, ChevronUp, CheckCircle, Circle, XCircle, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface TodoListProps {
  todoList: TodoListType | null;
}

export default function TodoList({ todoList }: TodoListProps) {
  const t = useTranslations('sessions');
  const [isCollapsed, setIsCollapsed] = useState(false);

  if (!todoList || todoList.items.length === 0) {
    return null;
  }

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  const getStatusIcon = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'in_progress':
        return <Clock className="w-4 h-4 text-blue-500" />;
      case 'cancelled':
        return <XCircle className="w-4 h-4 text-gray-500" />;
      case 'pending':
      default:
        return <Circle className="w-4 h-4 text-gray-400" />;
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div
        className="flex items-center justify-between p-3 cursor-pointer bg-gray-50 dark:bg-gray-750"
        onClick={toggleCollapse}
      >
        <h3 className="text-md font-medium text-gray-900 dark:text-white flex items-center gap-2">
          {t('todoList')}
          <span className="text-sm text-gray-500 dark:text-gray-400">
            ({todoList.items.filter((item) => item.status === 'completed').length}/{todoList.items.length})
          </span>
        </h3>
        <button className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700">
          {isCollapsed ? (
            <ChevronDown className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          ) : (
            <ChevronUp className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          )}
        </button>
      </div>

      {!isCollapsed && (
        <div className="p-3">
          <ul className="space-y-2">
            {todoList.items.map((item) => (
              <li
                key={item.id}
                className={`flex items-start gap-2 p-2 rounded ${
                  item.status === 'in_progress'
                    ? 'bg-blue-50 dark:bg-blue-900/20'
                    : item.status === 'completed'
                      ? 'bg-green-50 dark:bg-green-900/20'
                      : ''
                }`}
              >
                <div className="mt-0.5">{getStatusIcon(item.status)}</div>
                <div>
                  <div
                    className={`text-sm ${
                      item.status === 'completed'
                        ? 'line-through text-gray-500 dark:text-gray-400'
                        : 'text-gray-900 dark:text-gray-100'
                    }`}
                  >
                    {item.description}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('todoStatus')}: {t(`todoStatus_${item.status}`)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-xs text-right text-gray-500 dark:text-gray-400">
            {t('lastUpdated')}: {new Date(todoList.lastUpdated).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}
