import { todoInit, todoInitDef } from './todo-init';
import { todoUpdate, todoUpdateDef } from './todo-update';
import { getTodoList, formatTodoListMarkdown } from './todo-service';

export const todoTools = {
  todoInit,
  todoUpdate,
};

export const todoToolDefs = [todoInitDef, todoUpdateDef];

/**
 * Get the current todo list as markdown string to include in messages
 * @returns Formatted markdown string of the todo list or empty string if none exists
 */
export async function getCurrentTodoList(): Promise<string> {
  const todoList = await getTodoList();
  return formatTodoListMarkdown(todoList);
}

export * from './todo-list-hook';

export * from './types';
export * from './todo-service';