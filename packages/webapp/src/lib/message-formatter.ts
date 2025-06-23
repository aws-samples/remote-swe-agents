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
function removeSlackMentions(message: string): string {
  // Regular expression to match Slack mention format: <@USERID>
  const mentionRegex = /<@[A-Z0-9]+>/g;

  // Remove all Slack mentions
  const cleanedMessage = message.replace(mentionRegex, '');

  return cleanedMessage;
}

/**
 * Adds trailing spaces to URLs in the message
 *
 * @param message The message content to process
 * @returns The message with spaces added after URLs
 */
function addSpacesToUrls(message: string): string {
  // Regular expression to match URLs
  // https://stackoverflow.com/a/3809435
  const urlRegex =
    /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;

  // Add trailing space to URLs
  return message.replace(urlRegex, (match) => {
    return ' ' + match + ' ';
  });
}

export function formatMessage(message: string): string {
  // Remove Slack mentions
  message = removeSlackMentions(message);

  // Add trailing spaces to URLs
  message = addSpacesToUrls(message);

  // Remove any leading or trailing whitespace
  return message.trim();
}
