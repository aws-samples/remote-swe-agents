import { readMetadata, writeMetadata } from './metadata';
import { TodoItem, TodoList } from '../schema/todo';

export const TODO_METADATA_KEY = 'todo-list';

/**
 * Retrieve the current todo list for the session
 * @returns The current todo list or null if none exists
 */
export async function getTodoList(workerId: string): Promise<TodoList | null> {
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
export async function saveTodoList(todoList: TodoList, workerId: string): Promise<void> {
  await writeMetadata(TODO_METADATA_KEY, todoList, workerId);
}

/**
 * Initialize a new todo list with the given items
 * @param items Array of task descriptions to initialize
 * @returns The newly created todo list
 */
export async function initializeTodoList(items: string[], workerId: string): Promise<TodoList> {
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
 * Represents a single todo item update
 */
export interface TodoItemUpdate {
  id: string;
  status: TodoItem['status'];
  description?: string;
}

/**
 * Update multiple tasks in the todo list
 * @param updates Array of task updates with id, status and optional description
 * @returns Updated todo list or error if any update fails
 */
export async function updateTodoItems(
  updates: TodoItemUpdate[],
  workerId: string,
): Promise<{ success: true; updatedList: TodoList } | { success: false; error: string; currentList: TodoList | null }> {
  const todoList = await getTodoList(workerId);
  if (!todoList) {
    return { success: false, currentList: null, error: 'No todo list exists. Please create one first.' };
  }

  const now = Date.now();

  // Create a copy of the todo list to work with
  const updatedItems = [...todoList.items];

  // Update all the specified tasks
  for (const update of updates) {
    const { id, status, description } = update;

    // Find the task to update
    const taskIndex = updatedItems.findIndex((task) => task.id == id);
    if (taskIndex === -1) {
      return { success: false, currentList: todoList, error: `Task id ${id} was not found.` };
    }

    // Update the task
    updatedItems[taskIndex] = {
      ...updatedItems[taskIndex],
      status,
      description: description ?? updatedItems[taskIndex].description,
      updatedAt: now,
    };
  }

  const updatedList: TodoList = {
    items: updatedItems,
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

  await saveTodoList(updatedList, workerId);
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

class TodoListValidationError extends Error {}

async function validateTodoList(todoList: TodoList): Promise<true> {
  // Rule1. Only have ONE task in_progress at any time
  if (todoList.items.filter((item) => item.status === 'in_progress').length > 1) {
    throw new TodoListValidationError('Only one task can be in progress at a time.');
  }

  return true;
}
