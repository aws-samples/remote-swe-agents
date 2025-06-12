import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { updateTodoItem, updateTodoItems, TodoItemUpdate, formatTodoList } from '../../lib/todo';
import { todoInitTool } from './todo-init';

// Item update schema
const todoItemUpdateSchema = z.object({
  id: z.string().describe('The ID of the task to update'),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).describe('The new status for the task'),
  description: z.string().optional().describe('Optional new description for the task'),
});

// Input schema - array of updates only
const todoUpdateInputSchema = z.object({
  updates: z.array(todoItemUpdateSchema).nonempty().describe('Array of task updates to process in batch'),
});

async function todoUpdate(params: z.infer<typeof todoUpdateInputSchema>): Promise<string> {
  // Get updates from params
  const updates: TodoItemUpdate[] = params.updates;

  // Update the todo items
  const result = await updateTodoItems(updates);

  if (!result.success) {
    return `Update failed: ${result.error}\n\n${result.currentList ? `Current todo list:\n${formatTodoList(result.currentList)}` : ''}`.trim();
  }

  // Format the updated list as markdown
  const formattedList = formatTodoList(result.updatedList);

  // Create appropriate message based on number of updates
  let message: string;
  if (updates.length === 1) {
    message = `Task ${updates[0].id} updated to status: ${updates[0].status}`;
  } else {
    message = `${updates.length} tasks updated successfully`;
  }

  return `${message}\n\n${formattedList}`;
}

const name = 'todoUpdate';

/**
 * Tool to update tasks in the todo list
 */
export const todoUpdateTool: ToolDefinition<z.infer<typeof todoUpdateInputSchema>> = {
  name,
  handler: todoUpdate,
  schema: todoUpdateInputSchema,
  toolSpec: async () => ({
    name,
    description: `Update tasks in the todo list created by ${todoInitTool.name}.
Use this to mark tasks as completed, in progress, or to modify task descriptions.
Provide an array of updates to process multiple tasks at once.

If your update request is invalid, an error will be returned.
`.trim(),
    inputSchema: { json: zodToJsonSchemaBody(todoUpdateInputSchema) },
  }),
};
