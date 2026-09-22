/**
 * Normalize a tool name for comparison purposes. Treats spaces, underscores,
 * and hyphens as equivalent separators so that 'send_message_to_user',
 * 'Send Message To User', and 'send-message-to-user' all match. (Canonical tool
 * IDs are snake_case; the space/Title-Case forms are legacy history.)
 */
export const normalizeToolName = (name: string): string => name.replace(/[\s_-]+/g, '_').toLowerCase();

/**
 * Check if two tool names are equivalent after normalization.
 */
export const toolNamesEqual = (a: string, b: string): boolean => normalizeToolName(a) === normalizeToolName(b);

/**
 * Check if a tool name matches any entry in a set, using normalized comparison.
 */
export const toolNameInSet = (name: string, set: Set<string>): boolean => {
  const normalized = normalizeToolName(name);
  for (const entry of set) {
    if (normalizeToolName(entry) === normalized) return true;
  }
  return false;
};

/**
 * Per-word display overrides so acronyms/brand casing survive the snake_case →
 * Title Case round-trip (e.g. `get_pr_comments` → 'Get PR Comments',
 * `clone_github_repository` → 'Clone GitHub Repository'). Keyed by the
 * lower-case snake_case word segment.
 */
const DISPLAY_WORD_OVERRIDES: Record<string, string> = {
  pr: 'PR',
  github: 'GitHub',
};

/**
 * Convert a tool name to its canonical display form (spaced, Title Case).
 * Handles three input shapes:
 *   - canonical snake_case IDs      ('execute_command'      → 'Execute Command',
 *                                     'get_pr_comments'      → 'Get PR Comments',
 *                                     'clone_github_repository' → 'Clone GitHub Repository')
 *   - Bedrock-sanitized Title_Case  ('Execute_Command'      → 'Execute Command')
 *   - already-spaced / other        (returned unchanged)
 * Acronym/brand casing is preserved via {@link DISPLAY_WORD_OVERRIDES}.
 */
export const prettifyToolName = (name: string): string => {
  // Bedrock-sanitized Title_Case form (e.g. 'Execute_Command' -> 'Execute Command').
  if (/^[A-Z][a-zA-Z0-9]*(_[A-Z][a-zA-Z0-9]*)*$/.test(name)) {
    return name.replace(/_/g, ' ');
  }
  // Canonical snake_case tool IDs (e.g. 'execute_command' -> 'Execute Command').
  if (/^[a-z0-9]+(_[a-z0-9]+)*$/.test(name)) {
    return name
      .split('_')
      .map((w) => DISPLAY_WORD_OVERRIDES[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return name;
};
