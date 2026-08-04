import { reportProgressTool } from '../tools/report-progress';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws/ddb';
// Re-export client-safe sender types from their dedicated module so the
// existing `import { ... } from '@remote-swe-agents/agent-core/lib'` call
// sites stay valid. Anything in this `lib/` barrel can transitively pull
// `fs` / `child_process` / `net` etc. through other re-exports — clients
// that ONLY need the sender union should import from
// `@remote-swe-agents/agent-core/types/sender` instead to keep their
// bundles free of server-only modules.
export { USER_MESSAGE_SENDER_TYPES } from '../types/sender';
export type { UserMessageSenderType, UserMessageSender } from '../types/sender';
import type { UserMessageSender } from '../types/sender';

export const renderToolResult = (props: { toolResult: string; forceReport: boolean; parentSessionId?: string }) => {
  let forceReportMessage = '';
  if (props.forceReport) {
    forceReportMessage = props.parentSessionId
      ? `Long time has passed since you sent the last message. Please use sendMessageToAgent tool to report progress to the parent (session ID: ${props.parentSessionId}).`
      : `Long time has passed since you sent the last message. Please use ${reportProgressTool.name} tool to send a response asap.`;
  }
  return `
<result>
${props.toolResult}
</result>
<command>
${forceReportMessage}
</command>
`.trim();
};

/**
 * `UserMessageSender`, `UserMessageSenderType` and `USER_MESSAGE_SENDER_TYPES`
 * have moved to `../types/sender` (a leaf module with no runtime imports)
 * so client bundles can pull them without dragging in `fs` / `child_process`
 * via this `lib/` barrel. The names are still re-exported above for
 * backward compatibility with existing `from '@remote-swe-agents/agent-core/lib'`
 * call sites.
 */

/**
 * Sanitise a free-form sender label before embedding it inside an LLM prompt
 * envelope. Prevents prompt injection when the label is user-controlled
 * (Slack display names set by arbitrary workspace members, Cognito email
 * local parts, etc.).
 *
 * Defences applied:
 *   - collapse CR/LF to a single space so attackers cannot break out of the
 *     single-line `[from: ...]` header and inject follow-up pseudo-envelope
 *     sections (e.g. a fake `</user_message>\n<system>...</system>` tail).
 *   - strip `[`, `]`, `<`, `>` which would allow forging envelope-like
 *     opening/closing tags inside the label itself.
 *   - trim surrounding whitespace and clip to 64 chars so a very long label
 *     cannot dominate the prompt or trigger line-wrap-dependent parsing
 *     quirks.
 *
 * Exported for tests and for sibling modules that construct their own
 * sender-attributed prefixes (see `sendAgentMessage`, `createSession`).
 */
export function sanitizeSenderLabel(input: string): string {
  return input
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\[\]<>]/g, '')
    .trim()
    .slice(0, 64);
}

export const renderUserMessage = (props: { message: string; sender?: UserMessageSender }) => {
  const { message, sender } = props;
  let header = '';
  if (sender) {
    const name = sanitizeSenderLabel(sender.displayName ?? sender.id);
    const id = sanitizeSenderLabel(sender.id);
    // If the display-name collapses to an empty string post-sanitisation
    // (e.g. an attacker submits only control / bracket chars) fall back to
    // the sanitised id, and finally to a generic 'unknown' placeholder so we
    // always emit a readable header.
    const safeName = name || id || 'unknown';
    header = `[from: ${safeName} (${sender.type})]\n`;
  }
  // Defence in depth: if the user-typed body itself starts with the literal
  // `[from: ...]` pattern (either a copy-paste of an LLM trace or a deliberate
  // prompt-injection attempt), the LLM would see two consecutive headers and
  // could be tricked into attributing the message to a forged sender. We
  // insert a zero-width space (U+200B) between `[` and `from:` so the pattern
  // breaks for any header-recognition logic on the LLM side, while remaining
  // visually identical for human readers and not affecting the body's natural
  // language.
  //
  // Detection rules:
  //   - We trim leading whitespace before checking, so ` [from:`, `\t[from:`,
  //     `\n[from:` etc. cannot bypass the check by hiding the bracket behind
  //     indentation.
  //   - We lowercase the prefix portion before comparing, so `[From:`,
  //     `[FROM:`, `[fRoM:` cannot bypass via casing tricks. (The header
  //     `renderUserMessage` itself emits is always lowercase `[from:`, so
  //     the LLM has no incentive to trust mixed-case variants — but a fuzzy
  //     header parser might still be confused, hence the defensive
  //     normalization.)
  //   - We rewrite the FIRST occurrence of `[from:`/`[From:`/etc. in the
  //     leading non-whitespace position by inserting U+200B; surrounding
  //     whitespace is preserved verbatim so the body stays visually
  //     identical to the user's input.
  //
  // Scope:
  //   - applied to the START of the body only — a `[from: ...]` further in
  //     the message is harmless because it lacks the structural position
  //     used by header parsers.
  //   - applied unconditionally (i.e. even when no `sender` is provided),
  //     because the worry is the LLM mis-reading the body as a header, not
  //     just collision with our injected header.
  const safeBody = defangLeadingFromHeader(message);
  return `
<user_message>
${header}${safeBody}
</user_message>
<command>
User sent you a message. Please use ${reportProgressTool.name} tool to send a response asap.
</command>
`.trim();
};

/**
 * Internal: insert a U+200B between `[` and `from:` when the message body
 * starts with that literal header (case-insensitive, leading-whitespace
 * tolerant). Exported for tests; not part of the public surface.
 */
export function defangLeadingFromHeader(message: string): string {
  // Find the offset of the first non-whitespace character.
  const leadingWs = message.match(/^\s*/)?.[0] ?? '';
  const rest = message.slice(leadingWs.length);
  // Case-insensitive prefix check on the rest.
  if (rest.slice(0, '[from:'.length).toLowerCase() !== '[from:') {
    return message;
  }
  // Idempotency: if a ZWSP already sits between `[` and the rest, leave the
  // string alone. This handles re-rendering of an already-defanged body.
  if (rest.startsWith('[\u200B')) {
    return message;
  }
  // Preserve the original casing of `from:` etc. — we only insert the ZWSP.
  return `${leadingWs}[\u200B${rest.slice(1)}`;
}

export const renderAgentMessage = (props: { message: string; senderSessionId: string }) => {
  return `
<user_message>
${props.message}
</user_message>
<command>
An agent sent you a message. Please use sendMessageToAgent tool to reply to the sender (session ID: ${props.senderSessionId}).
</command>
`.trim();
};

export const renderSystemNotification = (props: { message: string }) => {
  return `
<user_message>
${props.message}
</user_message>
<command>
This is a system event notification, NOT a user message. Do not reply to the user. If action is needed, use sendMessageToAgent to communicate with your parent or the relevant session.
</command>
`.trim();
};

/**
 * Global config keys for DynamoDB
 */
export const GlobalConfigKeys = {
  PK: 'global-config',
  PromptSK: 'prompt',
};

/**
 * Type definition for common prompt data
 */
export interface CommonPromptData {
  additionalSystemPrompt: string;
}

/**
 * Read the common prompt from DynamoDB
 * @returns Promise with the common prompt data or null if not found
 */
export const readCommonPrompt = async (): Promise<CommonPromptData | null> => {
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName,
        Key: {
          PK: GlobalConfigKeys.PK,
          SK: GlobalConfigKeys.PromptSK,
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return {
      additionalSystemPrompt: result.Item.additionalSystemPrompt || '',
    };
  } catch (error) {
    console.error('Error reading common prompt:', error);
    return null;
  }
};

/**
 * Write the common prompt to DynamoDB
 * @param data The common prompt data to write
 * @returns Promise that resolves when the data is written
 */
export const writeCommonPrompt = async (data: CommonPromptData): Promise<void> => {
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: GlobalConfigKeys.PK,
        SK: GlobalConfigKeys.PromptSK,
        additionalSystemPrompt: data.additionalSystemPrompt,
      },
    })
  );
};
