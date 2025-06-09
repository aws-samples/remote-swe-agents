import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { updateTodoItem, formatTodoListMarkdown } from '../../lib/todo';
import { todoInitTool } from './todo-init';

const todoUpdateInputSchema = z.object({
  id: z.string().describe('The ID of the task to update'),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).describe('The new status for the task'),
  description: z.string().optional().describe('Optional new description for the task'),
});

async function todoUpdate(params: z.infer<typeof todoUpdateInputSchema>): Promise<string> {
  const { id, status, description } = params;

  // Validate status
  if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) {
    throw new Error('Status must be one of: pending, in_progress, completed, cancelled');
  }

  // Update the todo item
  const result = await updateTodoItem(id, status, description);

  if (!result.success) {
    return `Update failed: ${result.error}\n\n${result.currentList ? `Current todo list:\n${formatTodoListMarkdown(result.currentList)}` : ''}`.trim();
  }

  // Format the updated list as markdown
  const formattedList = formatTodoListMarkdown(result.updatedList);

  return `Task ${id} updated to status: ${status}\n\n${formattedList}`;
}

const name = 'todoUpdate';

/**
 * Tool to update a task in the todo list
 */
export const todoUpdateTool: ToolDefinition<z.infer<typeof todoUpdateInputSchema>> = {
  name,
  handler: todoUpdate,
  schema: todoUpdateInputSchema,
  toolSpec: async () => ({
    name,
    description: `Update an existing task in the todo list created by ${todoInitTool.name}.
Use this to mark tasks as completed, in progress, or to modify task descriptions.

If your update request is invalid, an error will be returned.
`.trim(),
    inputSchema: { json: zodToJsonSchemaBody(todoUpdateInputSchema) },
  }),
};
