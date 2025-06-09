import { todoInit, todoInitDef } from './todo-init';
import { todoUpdate, todoUpdateDef } from './todo-update';
import { getTodoList, formatTodoListMarkdown } from './todo-service';

// Create ToolDefinition objects to match the interface of other tools
export const todoInitTool = {
  handler: todoInit,
  name: todoInitDef.name,
  schema: todoInitDef,
  toolSpec: async () => todoInitDef,
};

export const todoUpdateTool = {
  handler: todoUpdate,
  name: todoUpdateDef.name,
  schema: todoUpdateDef,
  toolSpec: async () => todoUpdateDef,
};

export const todoTools = {
  todoInit: todoInitTool,
  todoUpdate: todoUpdateTool,
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
