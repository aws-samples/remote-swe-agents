/**
 * Pre-processor that escapes dollar signs used as currency/price markers so
 * that `remark-math` (with `singleDollarTextMath: true`) does not
 * accidentally pair them into spurious inline-math spans.
 *
 * A "price dollar" is defined as `$` immediately followed by a numeric token
 * (digits with optional commas, optional decimal, optional suffix k/K/M/B).
 * Examples: `$0.21`, `$100`, `$1,000`, `$100k`, `$2.5M`.
 *
 * The character AFTER the numeric token must NOT indicate a math expression
 * continuation. Math-continuation signals:
 * - `\`, `=`, `^`, `_` directly after the number
 * - `+` followed by a digit or letter (math operator, e.g. `$2+2=4$`)
 * - `*` followed by a digit or letter (multiplication, not markdown bold)
 * - An alphabetic character (variable like `$3x`)
 *
 * NOT treated as math continuation (high-frequency price patterns):
 * - `-` (price ranges: $100-200)
 * - `/` (per-unit prices: $0.60/unit)
 * - `+` followed by space/CJK/EOL (price suffix: $100+)
 *
 * Known limitations:
 * - `$2-1$`, `$1/2$`, `$3 x + 2$` (digit-start math with `-`, `/`, or space)
 *   are treated as prices. The base prompt instructs agents to start math
 *   expressions with a letter or `\` to avoid this.
 * - 4-space indented code blocks (no fence) are NOT protected. Only fenced
 *   code blocks (``` or ~~~) are detected. This is acceptable because agent
 *   output overwhelmingly uses fenced blocks.
 *
 * Exclusions:
 * - Already-escaped `\$` sequences are left untouched.
 * - `$$` (display math delimiter context) is excluded via lookbehind.
 * - Content inside fenced code blocks (``` ... ```) is never modified.
 *   Fences may be indented up to 3 spaces (CommonMark spec).
 * - Content inside inline code spans (` ... `) is never modified.
 * - Unclosed fenced code blocks (streaming) protect from fence-start to EOF.
 */

const INLINE_CODE = /`[^`\n]+`/g;

const PRICE_DOLLAR = /(?<![\\$])\$(\d[\d,]*(?:\.\d+)?[kKMB]?)/g;

function isMathContinuation(text: string, afterIdx: number): boolean {
  const ch = text[afterIdx];
  if (!ch) return false;

  // Direct math operators (unambiguous with price patterns)
  if (/^[\\=^_]/.test(ch)) return true;

  // Alphabetic character immediately after number = likely a math variable ($3x, $2n)
  if (/^[a-zA-Z]/.test(ch)) return true;

  // `+` is ambiguous: could be price suffix ($100+) or math addition ($2+2)
  // Treat as math only if followed by a digit or letter (e.g. $2+2, $2+x)
  if (ch === '+') {
    const next = text[afterIdx + 1];
    if (next && /^[0-9a-zA-Z]/.test(next)) return true;
    return false;
  }

  // `*` is ambiguous: could be markdown bold or math multiplication
  // Treat as math only if followed by a digit or letter (e.g. $2*3, $2*x)
  if (ch === '*') {
    const next = text[afterIdx + 1];
    if (next && /^[0-9a-zA-Z]/.test(next)) return true;
  }

  return false;
}

export function escapePriceDollars(markdown: string): string {
  const preserved: { placeholder: string; original: string }[] = [];
  let counter = 0;

  function preserve(original: string): string {
    const placeholder = `\x00PRESERVE${counter++}\x00`;
    preserved.push({ placeholder, original });
    return placeholder;
  }

  // Phase 1: Protect fenced code blocks via line-by-line scan.
  // Opening fence: 0-3 spaces indent + 3+ backticks or tildes (CommonMark spec).
  // Closing fence: same char type, length >= opening fence, 0-3 spaces indent.
  const lines = markdown.split('\n');
  const segments: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const openMatch = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (openMatch) {
      const fenceChar = openMatch[1][0];
      const fenceLen = openMatch[1].length;
      const closeRe = new RegExp(`^ {0,3}\\${fenceChar}{${fenceLen},}\\s*$`);
      const blockLines = [lines[i]];
      i++;
      let closed = false;
      while (i < lines.length) {
        blockLines.push(lines[i]);
        if (closeRe.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      // Whether closed or unclosed (streaming), protect the entire block
      segments.push(preserve(blockLines.join('\n')));
    } else {
      segments.push(lines[i]);
      i++;
    }
  }
  let result = segments.join('\n');

  // Phase 2: Protect inline code spans (single-line only to prevent paragraph-spanning)
  result = result.replace(INLINE_CODE, (m) => preserve(m));

  // Phase 3: Escape price dollars, but skip if followed by math-continuation signal
  result = result.replace(PRICE_DOLLAR, (match, digits: string, offset: number) => {
    const afterIdx = offset + match.length;
    if (isMathContinuation(result, afterIdx)) {
      return match;
    }
    return `\\$${digits}`;
  });

  // Phase 4: Restore preserved blocks using function replacement to avoid
  // special replacement patterns ($$ $& $' $` etc.) in the original content
  for (const { placeholder, original } of preserved) {
    result = result.replace(placeholder, () => original);
  }

  return result;
}
