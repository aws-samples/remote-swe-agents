export interface TodoItem {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}

export interface TodoList {
  items: TodoItem[];
  lastUpdated: number;
}

export const TODO_METADATA_KEY = 'todo-list';
