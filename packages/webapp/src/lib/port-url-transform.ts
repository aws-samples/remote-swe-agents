/**
 * Helpers for rewriting `localhost:PORT` / `127.0.0.1:PORT` references in
 * agent-produced text to clickable public preview URLs based on the ports
 * opened via the `openPort` tool.
 *
 * This module is deliberately framework-agnostic (no React) so it can be
 * unit-tested in isolation and reused by both markdown and plain-text
 * renderers.
 */

export type OpenedPort = {
  fromPort: number;
  toPort: number;
  cidr: string;
  openedAt: number;
};

export type PortMapping = {
  hostname?: string;
  openedPorts: OpenedPort[];
  /**
   * When set, indicates this is a CloudFront preview URL that should not
   * include the port number in the output (traffic is routed through the
   * tunnel automatically). The value is the full base URL including protocol
   * and path prefix (e.g. "https://preview.example.com/worker-123").
   */
  previewBaseUrl?: string;
};

// Matches localhost / 127.0.0.1 host references with a REQUIRED port.
// Captures:
//   1 - optional scheme ("http://" or "https://")
//   2 - host token ("localhost" or "127.0.0.1")
//   3 - port number
//   4 - optional path+query+fragment starting with '/'
//
// Notes:
// - We require an explicit port to avoid matching prose like "localhost".
// - The path terminates at whitespace or common trailing punctuation so URLs
//   embedded in sentences ("...open localhost:3000, then...") don't eat the
//   comma.
const LOCALHOST_URL_REGEX = /(https?:\/\/)?(localhost|127\.0\.0\.1):(\d{1,5})(\/[^\s<>"'`\])}]*)?/gi;

/**
 * Returns true when `port` falls inside any of the currently opened ranges.
 */
export const isPortOpen = (port: number, openedPorts: readonly OpenedPort[]): boolean =>
  openedPorts.some((p) => port >= p.fromPort && port <= p.toPort);

export type TransformMatch = {
  /** The exact substring that was matched in the input. */
  original: string;
  /** The rewritten public URL, if the port is currently open. */
  replacement?: string;
  /** Start index in the original input. */
  start: number;
  /** End index (exclusive) in the original input. */
  end: number;
  /** Parsed port number. */
  port: number;
};

/**
 * Locate every localhost/127.0.0.1 reference in `input` and, when the port is
 * in the opened-ports set, compute its public-URL replacement. Matches whose
 * port is not open are returned with `replacement === undefined`; callers can
 * decide whether to leave them untouched or annotate them.
 */
export const findPortMatches = (input: string, mapping: PortMapping | null | undefined): TransformMatch[] => {
  if (!input) return [];
  const hostname = mapping?.hostname;
  const previewBaseUrl = mapping?.previewBaseUrl;
  const openedPorts = mapping?.openedPorts ?? [];
  const results: TransformMatch[] = [];

  // Reset lastIndex because the regex has the /g flag.
  LOCALHOST_URL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOCALHOST_URL_REGEX.exec(input)) !== null) {
    const [fullMatch, scheme, , portStr, pathPart] = match;
    const port = Number.parseInt(portStr, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) continue;

    const entry: TransformMatch = {
      original: fullMatch,
      start: match.index,
      end: match.index + fullMatch.length,
      port,
    };

    if (isPortOpen(port, openedPorts)) {
      if (previewBaseUrl) {
        // CloudFront preview: URL is the base URL + the path (no port needed)
        const effectivePath = pathPart ?? '';
        entry.replacement = `${previewBaseUrl}${effectivePath}`;
      } else if (hostname) {
        // EC2 direct: URL includes the port
        const effectiveScheme = scheme ?? 'http://';
        const effectivePath = pathPart ?? '';
        entry.replacement = `${effectiveScheme}${hostname}:${port}${effectivePath}`;
      }
    }

    results.push(entry);
  }

  return results;
};

/**
 * Rewrite every open-port localhost reference in `input` to its public URL.
 * References pointing at ports that are not currently open (or when no
 * mapping is provided) are left untouched.
 */
export const rewriteLocalhostUrls = (input: string, mapping: PortMapping | null | undefined): string => {
  if (!input || (!mapping?.hostname && !mapping?.previewBaseUrl) || mapping.openedPorts.length === 0) return input;

  const matches = findPortMatches(input, mapping).filter((m) => m.replacement);
  if (matches.length === 0) return input;

  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += input.slice(cursor, m.start);
    out += m.replacement!;
    cursor = m.end;
  }
  out += input.slice(cursor);
  return out;
};

/**
 * Minimal structural types for the mdast subset we touch. Full mdast types
 * live in `@types/mdast`, but we avoid adding that dependency just for one
 * tree walk — the AST shape we care about is stable and narrow.
 */
export type MdastNode = { type: string; value?: string; url?: string; children?: MdastNode[] } & Record<string, any>;

/**
 * In-place rewrite of an mdast tree: every `text` node whose value contains a
 * reference to a currently-open localhost port is split into text nodes plus
 * `link` nodes pointing at the public URL. `code` and `inlineCode` subtrees
 * are intentionally skipped so markdown code samples and backticked inline
 * snippets render verbatim.
 *
 * Exported as a standalone pure function so it can be unit-tested against
 * hand-written mdast fragments without booting React / react-markdown.
 */
export const rewriteMdastLocalhostUrls = (tree: MdastNode, mapping: PortMapping | null | undefined): void => {
  if ((!mapping?.hostname && !mapping?.previewBaseUrl) || mapping.openedPorts.length === 0) return;

  const visit = (node: MdastNode, parent: MdastNode | null, index: number | null): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'code' || node.type === 'inlineCode') return;

    if (
      node.type === 'text' &&
      typeof node.value === 'string' &&
      parent &&
      Array.isArray(parent.children) &&
      index != null
    ) {
      const matches = findPortMatches(node.value, mapping).filter((m) => m.replacement);
      if (matches.length === 0) return;

      const pieces: MdastNode[] = [];
      let cursor = 0;
      for (const m of matches) {
        if (m.start > cursor) {
          pieces.push({ type: 'text', value: node.value.slice(cursor, m.start) });
        }
        pieces.push({
          type: 'link',
          url: m.replacement,
          children: [{ type: 'text', value: m.replacement }],
        });
        cursor = m.end;
      }
      if (cursor < node.value.length) {
        pieces.push({ type: 'text', value: node.value.slice(cursor) });
      }

      parent.children.splice(index, 1, ...pieces);
      return;
    }

    if (Array.isArray(node.children)) {
      // Iterate backwards so in-place splices don't shift future indices.
      for (let i = node.children.length - 1; i >= 0; i--) {
        visit(node.children[i], node, i);
      }
    }
  };

  visit(tree, null, null);
};
