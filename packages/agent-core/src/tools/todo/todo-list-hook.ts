import { getCurrentTodoList } from './index';

/**
 * Hook to append the current todo list to a message
 * @param message The original message
 * @returns The message with appended todo list
 */
export async function appendTodoList(message: string): Promise<string> {
  const todoList = await getCurrentTodoList();

  if (!todoList) {
    return message;
  }

  return `${message}\n\n${todoList}`;
}
