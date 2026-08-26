/**
 * Normalize a tool name for comparison purposes. Treats spaces, underscores,
 * and hyphens as equivalent separators so that 'Send Message To User',
 * 'Send_Message_To_User', and 'send-message-to-user' all match.
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
 * Convert a Bedrock-sanitized tool name back to its canonical display form.
 * Only applies to names that match Title_Case pattern (e.g. 'Execute_Command'
 * → 'Execute Command'). snake_case names (e.g. 'execute_bash', 'str_replace')
 * and names already containing spaces are returned unchanged.
 */
export const prettifyToolName = (name: string): string => {
  if (/^[A-Z][a-zA-Z0-9]*(_[A-Z][a-zA-Z0-9]*)*$/.test(name)) {
    return name.replace(/_/g, ' ');
  }
  return name;
};
