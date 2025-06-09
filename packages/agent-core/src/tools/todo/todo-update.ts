import { updateTodoItem, formatTodoListMarkdown } from './todo-service';
import { TodoItem } from './types';

interface TodoUpdateParams {
  id: string;
  status: TodoItem['status'];
  description?: string;
}

interface TodoUpdateResult {
  todoList: string;
  success: boolean;
}

/**
 * Tool to update a task in the todo list
 */
export async function todoUpdate(params: TodoUpdateParams): Promise<TodoUpdateResult> {
  const { id, status, description } = params;
  
  // Validate status
  if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) {
    throw new Error('Status must be one of: pending, in_progress, completed, cancelled');
  }
  
  // Update the todo item
  const updatedList = await updateTodoItem(id, status, description);
  
  if (!updatedList) {
    return {
      todoList: 'No todo list found. Please create one first using todoInit.',
      success: false,
    };
  }
  
  // Format the updated list as markdown
  const formattedList = formatTodoListMarkdown(updatedList);
  
  return {
    todoList: formattedList,
    success: true,
  };
}

export const todoUpdateDef = {
  name: 'todoUpdate',
  description: `Update an existing task in the todo list. 
Use this to mark tasks as completed, in progress, or to modify task descriptions.`,
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The ID of the task to update',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'cancelled'],
        description: 'The new status for the task',
      },
      description: {
        type: 'string',
        description: 'Optional new description for the task',
      },
    },
    required: ['id', 'status'],
  },
  returns: {
    type: 'object',
    properties: {
      todoList: {
        type: 'string',
        description: 'The updated todo list formatted as markdown',
      },
      success: {
        type: 'boolean',
        description: 'Whether the update was successful',
      },
    },
  },
} as const;