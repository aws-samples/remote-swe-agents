/**
 * Server-side Mermaid diagram validator.
 *
 * Extracts fenced mermaid code blocks from assistant text and validates
 * them using the mermaid library with a jsdom-backed DOM environment.
 * Used by the orchestrator to detect broken diagrams before they reach
 * the user, enabling LLM retry.
 */

const MERMAID_FENCE_RE = /```mermaid\s*\n([\s\S]*?)```/gi;

/** Lazily-initialised mermaid instance (singleton). */
let mermaidInstance: { parse: (text: string) => Promise<unknown> } | undefined;

/**
 * Initialise the jsdom + mermaid environment once per process. Subsequent
 * calls return the cached instance. Uses dynamic import so the heavy deps
 * are only loaded when mermaid validation is actually needed.
 */
const getMermaid = async (): Promise<{ parse: (text: string) => Promise<unknown> }> => {
  if (mermaidInstance) return mermaidInstance;

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  try {
    (globalThis as any).navigator = dom.window.navigator;
  } catch {
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      writable: true,
      configurable: true,
    });
  }

  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });

  mermaidInstance = mermaid;
  return mermaidInstance;
};

export interface MermaidValidationError {
  /** The chart source that failed validation. */
  chart: string;
  /** Error message from the parser. */
  message: string;
}

export interface MermaidValidationResult {
  /** True when all mermaid blocks (if any) are syntactically valid. */
  valid: boolean;
  /** Details for each block that failed. Empty when valid. */
  errors: MermaidValidationError[];
}

/**
 * Extract closed mermaid fenced code blocks from `text` and validate each
 * one. Returns `{ valid: true, errors: [] }` when there are no mermaid
 * blocks or all blocks parse successfully.
 */
export const validateMermaidInText = async (text: string): Promise<MermaidValidationResult> => {
  const charts: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(MERMAID_FENCE_RE.source, MERMAID_FENCE_RE.flags);
  while ((match = re.exec(text)) !== null) {
    charts.push(match[1].trim());
  }

  if (charts.length === 0) {
    return { valid: true, errors: [] };
  }

  const mermaid = await getMermaid();
  const errors: MermaidValidationError[] = [];

  for (const chart of charts) {
    try {
      const result = await mermaid.parse(chart);
      if (result === false) {
        errors.push({ chart, message: 'parse() returned false' });
      }
    } catch (e) {
      errors.push({ chart, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { valid: errors.length === 0, errors };
};

/**
 * Build a concise LLM-facing feedback string describing which mermaid
 * blocks failed and why. Used as the content of the retry feedback message.
 */
export const buildMermaidFeedback = (errors: MermaidValidationError[]): string => {
  const lines = [
    '[SYSTEM] Your previous response contained invalid Mermaid diagram syntax. Please regenerate your response with corrected Mermaid diagrams.',
    '',
    `${errors.length} diagram(s) failed validation:`,
  ];
  for (let i = 0; i < errors.length; i++) {
    lines.push(`--- Diagram ${i + 1} ---`);
    lines.push(`Error: ${errors[i].message}`);
    lines.push(`Source:\n\`\`\`\n${errors[i].chart}\n\`\`\``);
  }
  lines.push('', 'Please fix the Mermaid syntax errors and regenerate your complete response.');
  return lines.join('\n');
};
