'use client';

import React from 'react';
import { TodoItem, TodoList as TodoListType } from '@remote-swe-agents/agent-core/schema';
import { CheckCircle, Circle, XCircle, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface TodoListProps {
  todoList: TodoListType | null;
}

export default function TodoList({ todoList }: TodoListProps) {
  const t = useTranslations('sessions');

  if (!todoList || todoList.items.length === 0) {
    return null;
  }

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
    <>
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
    </>
  );
}
