/**
 * Utility functions for formatting and cleaning message content.
 *
 * IMPORTANT: this file is imported by client components
 * (`SessionPageClient.tsx` → `dedup.ts` → here). Imports MUST be
 * client-safe — pulling from `@remote-swe-agents/agent-core/lib`
 * transitively drags `fs`, `child_process`, `net` etc. into the browser
 * bundle and breaks `next build`. The dedicated
 * `@remote-swe-agents/agent-core/types/sender` subpath exists exactly for
 * this case: a leaf module with NO runtime imports, safe to ship to the
 * browser.
 */

import { USER_MESSAGE_SENDER_TYPES } from '@remote-swe-agents/agent-core/types/sender';

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

export function extractUserMessage(message: string | undefined): string {
  if (!message) return message ?? '';

  if (!message.includes('<user_message>') || !message.includes('</user_message>')) {
    return message.trim();
  }

  return message
    .slice(message.indexOf('<user_message>') + '<user_message>'.length, message.indexOf('</user_message>'))
    .trim();
}

/**
 * Strips the "[Message from AgentName]: " prefix from agent-to-agent messages.
 * The sender name is already shown in the UI header, so the prefix is redundant.
 */
export function stripAgentMessagePrefix(message: string): string {
  return message.replace(/^\[Message from [^\]]+\]:\s*/, '');
}

/**
 * Strips the leading `[from: <displayName> (<slack|webapp|apikey|...>)]`
 * header that `renderUserMessage` injects into user-message envelopes for
 * LLM-side sender attribution.
 *
 * The prefix is purely a hint to the model — the webapp renders the sender
 * separately via `MessageView.userSenderDisplayName` (see `MessageGroup`),
 * so showing the raw `[from: ...]` line inside the chat bubble is
 * redundant and was reported as visually noisy during E2E.
 *
 * Scope: matches ONLY the sender types declared in
 * `USER_MESSAGE_SENDER_TYPES` (currently slack/webapp/apikey), and ONLY at
 * the start of the string followed by an optional newline. The regex is
 * derived from the same const tuple that `UserMessageSender['type']` is
 * derived from, so adding a new sender type to that tuple automatically
 * extends this strip without a manual edit here. We deliberately do NOT
 * match arbitrary `(...)` content so that a real user message that happens
 * to start with "[from: ...(something else)" is not corrupted.
 *
 * Idempotent: multiple applications return the same result.
 */
const SENDER_TYPE_PATTERN = USER_MESSAGE_SENDER_TYPES.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const STRIP_SENDER_PREFIX_REGEX = new RegExp(`^\\[from:[^\\]]*\\((?:${SENDER_TYPE_PATTERN})\\)\\]\\n?`);

export function stripSenderPrefix(message: string): string {
  return message.replace(STRIP_SENDER_PREFIX_REGEX, '');
}
