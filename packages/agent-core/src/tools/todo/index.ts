import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { getTodoList, formatTodoListMarkdown, initializeTodoList, updateTodoItem } from './todo-service';
import { TodoItem } from './types';

// Input schema for todoInit
const todoInitInputSchema = z.object({
  items: z.array(z.string()).describe('Array of task descriptions to initialize the list with'),
});

// Input schema for todoUpdate
const todoUpdateInputSchema = z.object({
  id: z.string().describe('The ID of the task to update'),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).describe('The new status for the task'),
  description: z.string().optional().describe('Optional new description for the task'),
});

// TodoInit tool implementation
export const todoInitTool: ToolDefinition<z.infer<typeof todoInitInputSchema>> = {
  name: 'todoInit',
  handler: async (input: z.infer<typeof todoInitInputSchema>) => {
    const todoList = await initializeTodoList(input.items);
    const formattedList = formatTodoListMarkdown(todoList);
    return `Todo list initialized with ${input.items.length} item(s):\n\n${formattedList}`;
  },
  schema: todoInitInputSchema,
  toolSpec: async () => ({
    name: 'todoInit',
    description: `Initialize a new todo list or replace the existing one. 
Use this when starting a new multi-step task or when you need to reset the current list.`,
    inputSchema: zodToJsonSchemaBody(todoInitInputSchema),
  }),
};

// TodoUpdate tool implementation
export const todoUpdateTool: ToolDefinition<z.infer<typeof todoUpdateInputSchema>> = {
  name: 'todoUpdate',
  handler: async (input: z.infer<typeof todoUpdateInputSchema>) => {
    const updatedList = await updateTodoItem(input.id, input.status, input.description);
    if (!updatedList) {
      return 'No todo list found. Please create one first using todoInit.';
    }
    const formattedList = formatTodoListMarkdown(updatedList);
    return `Task ${input.id} updated to status: ${input.status}\n\n${formattedList}`;
  },
  schema: todoUpdateInputSchema,
  toolSpec: async () => ({
    name: 'todoUpdate',
    description: `Update an existing task in the todo list. 
Use this to mark tasks as completed, in progress, or to modify task descriptions.`,
    inputSchema: zodToJsonSchemaBody(todoUpdateInputSchema),
  }),
};

export const todoTools = {
  todoInit: todoInitTool,
  todoUpdate: todoUpdateTool,
};

// Export tool definitions for direct use
export const todoToolDefs = [
  {
    name: 'todoInit',
    description: 'Initialize a new todo list or replace the existing one',
    parameters: todoInitInputSchema,
  },
  {
    name: 'todoUpdate',
    description: 'Update an existing task in the todo list',
    parameters: todoUpdateInputSchema,
  },
];

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
