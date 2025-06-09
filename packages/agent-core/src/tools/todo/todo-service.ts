import { readMetadata, writeMetadata } from '../../lib/metadata';
import { TodoItem, TodoList, TODO_METADATA_KEY } from './types';

/**
 * Retrieve the current todo list for the session
 * @returns The current todo list or null if none exists
 */
export async function getTodoList(workerId: string = process.env.WORKER_ID!): Promise<TodoList | null> {
  try {
    const metadata = await readMetadata(TODO_METADATA_KEY, workerId);
    if (!metadata?.items) {
      return null;
    }
    return metadata as TodoList;
  } catch (error) {
    console.error('Error retrieving todo list:', error);
    return null;
  }
}

/**
 * Save a todo list to session metadata
 * @param todoList The todo list to save
 */
export async function saveTodoList(todoList: TodoList, workerId: string = process.env.WORKER_ID!): Promise<void> {
  try {
    await writeMetadata(TODO_METADATA_KEY, todoList, workerId);
  } catch (error) {
    console.error('Error saving todo list:', error);
    throw new Error(`Failed to save todo list: ${error}`);
  }
}

/**
 * Initialize a new todo list with the given items
 * @param items Array of task descriptions to initialize
 * @returns The newly created todo list
 */
export async function initializeTodoList(
  items: string[],
  workerId: string = process.env.WORKER_ID!
): Promise<TodoList> {
  const now = Date.now();

  const todoList: TodoList = {
    items: items.map((description, index) => ({
      id: `task-${index + 1}`,
      description,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })),
    lastUpdated: now,
  };

  await saveTodoList(todoList, workerId);
  return todoList;
}

/**
 * Update a task in the todo list
 * @param id ID of the task to update
 * @param status New status for the task
 * @param description Optional new description for the task
 * @returns Updated todo list or null if no list exists
 */
export async function updateTodoItem(
  id: string,
  status: TodoItem['status'],
  description?: string,
  workerId: string = process.env.WORKER_ID!
): Promise<TodoList | null> {
  const todoList = await getTodoList(workerId);
  if (!todoList) {
    return null;
  }

  const now = Date.now();

  // Find and update the task
  const updatedItems = todoList.items.map((item) => {
    if (item.id === id) {
      return {
        ...item,
        status,
        description: description || item.description,
        updatedAt: now,
      };
    }
    return item;
  });

  const updatedList: TodoList = {
    items: updatedItems,
    lastUpdated: now,
  };

  await saveTodoList(updatedList, workerId);
  return updatedList;
}

/**
 * Format the todo list as a markdown string
 * @param todoList The todo list to format
 * @returns Formatted markdown string
 */
export function formatTodoListMarkdown(todoList: TodoList | null): string {
  if (!todoList || todoList.items.length === 0) {
    return '';
  }

  let markdown = '## Todo List\n\n';

  todoList.items.forEach((item) => {
    const checked = item.status === 'completed' ? 'x' : ' ';
    let statusLabel = '';

    if (item.status === 'in_progress') {
      statusLabel = ' [進行中]';
    } else if (item.status === 'cancelled') {
      statusLabel = ' [キャンセル]';
    }

    markdown += `- [${checked}] ${item.description}${statusLabel} (${item.id})\n`;
  });

  return markdown;
}
