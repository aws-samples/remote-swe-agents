/**
 * Utility functions for formatting and cleaning message content
 */

/**
 * Removes Slack mention strings (e.g. <@U07UDD582EA>) from a message
 * If the resulting string is empty (or only whitespace), returns null
 *
 * @param message The message content to process
 * @returns The cleaned message or null if empty
 */
export function removeSlackMentions(message: string): string | null {
  if (!message) return null;

  // Regular expression to match Slack mention format: <@USERID>
  const mentionRegex = /<@[A-Z0-9]+>/g;

  // Remove all Slack mentions
  const cleanedMessage = message.replace(mentionRegex, '');

  // Check if the resulting string is empty or only contains whitespace
  if (!cleanedMessage.trim()) {
    return null;
  }

  return cleanedMessage;
}
