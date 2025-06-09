import { initializeTodoList, formatTodoListMarkdown } from './todo-service';

interface TodoInitParams {
  items: string[];
}

interface TodoInitResult {
  todoList: string;
}

/**
 * Tool to initialize or replace a todo list
 */
export async function todoInit(params: TodoInitParams): Promise<TodoInitResult> {
  const { items } = params;
  
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Items parameter must be a non-empty array of task descriptions');
  }
  
  // Initialize the todo list
  const todoList = await initializeTodoList(items);
  
  // Format the todo list as markdown
  const formattedList = formatTodoListMarkdown(todoList);
  
  return {
    todoList: formattedList,
  };
}

export const todoInitDef = {
  name: 'todoInit',
  description: `Initialize a new todo list or replace the existing one. 
Use this when starting a new multi-step task or when you need to reset the current list.`,
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Array of task descriptions to initialize the list with',
        items: {
          type: 'string',
        },
      },
    },
    required: ['items'],
  },
  returns: {
    type: 'object',
    properties: {
      todoList: {
        type: 'string',
        description: 'The initialized todo list formatted as markdown',
      },
    },
  },
} as const;