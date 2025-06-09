import { getCurrentTodoList } from '../tools/todo';

/**
 * Modifies prompts or messages by adding additional context like the current todo list
 * @param text The original text to modify
 * @returns The modified text with additional context
 */
export async function addContextToText(text: string): Promise<string> {
  // Get the current todo list
  const todoList = await getCurrentTodoList();
  
  // If there's no todo list, return the original text
  if (!todoList) {
    return text;
  }
  
  // Append the todo list to the text
  return `${text}\n\n${todoList}`;
}

/**
 * Modifies the system prompt by adding additional context
 * @param systemPrompt The original system prompt
 * @returns The modified system prompt with additional context
 */
export async function modifySystemPrompt(systemPrompt: string): Promise<string> {
  return addContextToText(systemPrompt);
}

/**
 * Modifies a user message by adding additional context
 * @param userMessage The original user message
 * @returns The modified user message with additional context
 */
export async function modifyUserMessage(userMessage: string): Promise<string> {
  return addContextToText(userMessage);
}

/**
 * Modifies a tool result by adding additional context
 * @param toolResult The original tool result
 * @returns The modified tool result with additional context
 */
export async function modifyToolResult(toolResult: string): Promise<string> {
  return addContextToText(toolResult);
}