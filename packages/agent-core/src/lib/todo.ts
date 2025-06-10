import { WorkerId } from '../env';
import { readMetadata, writeMetadata } from './metadata';
import { TodoItem, TodoList } from '../schema/todo';

export const TODO_METADATA_KEY = 'todo-list';

/**
 * Retrieve the current todo list for the session
 * @returns The current todo list or null if none exists
 */
export async function getTodoList(workerId = WorkerId): Promise<TodoList | null> {
  const metadata = await readMetadata(TODO_METADATA_KEY, workerId);
  if (!metadata?.items) {
    return null;
  }
  return metadata as TodoList;
}

/**
 * Save a todo list to session metadata
 * @param todoList The todo list to save
 */
export async function saveTodoList(todoList: TodoList, workerId = WorkerId): Promise<void> {
  await writeMetadata(TODO_METADATA_KEY, todoList, workerId);
}

/**
 * Initialize a new todo list with the given items
 * @param items Array of task descriptions to initialize
 * @returns The newly created todo list
 */
export async function initializeTodoList(items: string[]): Promise<TodoList> {
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

  await saveTodoList(todoList);
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
  description?: string
): Promise<{ success: true; updatedList: TodoList } | { success: false; error: string; currentList: TodoList | null }> {
  const todoList = await getTodoList();
  if (!todoList) {
    return { success: false, currentList: null, error: 'No todo list exists. Please create one first.' };
  }

  const now = Date.now();

  // Find and update the task
  const task = todoList.items.find((task) => task.id == id);
  if (!task) {
    return { success: false, currentList: null, error: `Task id ${id} was not found.` };
  }
  task.status = status;
  task.description = description ?? task.description;
  task.updatedAt = now;

  const updatedList: TodoList = {
    items: todoList.items,
    lastUpdated: now,
  };
  try {
    await validateTodoList(updatedList);
  } catch (e) {
    if (e instanceof TodoListValidationError) {
      return { success: false, error: e.message, currentList: todoList };
    }
    throw e;
  }

  await saveTodoList(updatedList);
  return { success: true, updatedList };
}

/**
 * Format the todo list as a markdown string
 * @param todoList The todo list to format
 * @returns Formatted markdown string
 */
export function formatTodoList(todoList: TodoList | null): string {
  if (!todoList || todoList.items.length === 0) {
    return '';
  }

  let markdown = '## Todo List\n';

  todoList.items.forEach((item) => {
    markdown += `- id:${item.id} (${item.status}) ${item.description}\n`;
  });

  return markdown;
}

/**
 * Get the current todo list as markdown string to include in messages
 * @returns Formatted markdown string of the todo list or empty string if none exists
 */
export async function getCurrentTodoList(workerId = WorkerId): Promise<string> {
  const todoList = await getTodoList(workerId);
  return formatTodoList(todoList);
}

class TodoListValidationError extends Error {}

async function validateTodoList(todoList: TodoList): Promise<true> {
  // Rule1. Only have ONE task in_progress at any time
  if (todoList.items.filter((item) => item.status === 'in_progress').length > 1) {
    throw new TodoListValidationError('Only one task can be in progress at a time.');
  }

  return true;
}
