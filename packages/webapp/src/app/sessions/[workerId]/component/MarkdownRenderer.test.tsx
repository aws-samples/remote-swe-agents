import { describe, expect, test } from 'vitest';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

/**
 * `MarkdownRenderer` (the React component) wires `react-markdown` with
 * `remark-gfm` + `remark-cjk-friendly` + `remark-cjk-friendly-gfm-strikethrough` +
 * `remark-math` + `[rehype-katex, { errorColor: 'currentColor' }]`.
 * Internally that pipeline is just `unified().use(remarkParse).use(...)` —
 * so we can pin the math behaviour we ship to users by running the same
 * plugin chain at the unified level and asserting on the produced HTML.
 *
 * Why not render the React component? Vitest is configured with
 * `environment: 'node'` for the rest of the webapp tests, and KaTeX itself
 * is plain string→string; mounting via jsdom would only test React's
 * pass-through behaviour, not the plugin pipeline. Keeping the test at the
 * unified level matches the existing pure-function style (see
 * `MessageList.test.ts`, `port-url-transform.test.ts`).
 *
 * If `MarkdownRenderer.tsx` ever changes its plugin set or options, this
 * mirror MUST be updated to match — that's the whole point of a regression
 * pin.
 */
const REHYPE_KATEX_OPTIONS = { errorColor: 'currentColor' } as const;

function renderMarkdown(markdown: string): string {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCjkFriendly)
    .use(remarkCjkFriendlyGfmStrikethrough)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeKatex, REHYPE_KATEX_OPTIONS)
    .use(rehypeStringify)
    .processSync(markdown)
    .toString();
}

describe('MarkdownRenderer math pipeline', () => {
  test('inline math `$E=mc^2$` renders as a .katex span', () => {
    const html = renderMarkdown('Inline: $E=mc^2$ here');
    expect(html).toMatch(/class="katex"/);
    // Block-display container must NOT appear for inline math.
    expect(html).not.toMatch(/class="katex-display"/);
    // KaTeX rewrites the source into MathML + HTML; presence of the
    // <annotation encoding="application/x-tex"> with the original TeX is
    // a stable signal across KaTeX versions.
    expect(html).toContain('E=mc^2');
  });

  test('block math `$$...$$` renders as a .katex-display block', () => {
    const html = renderMarkdown('$$\n\\sum_{i=1}^n i\n$$');
    expect(html).toMatch(/class="katex-display"/);
    expect(html).toContain('\\sum_{i=1}^n i');
  });

  test('two single-dollar tokens render as math (GitHub-compatible behaviour)', () => {
    // Known caveat of `remark-math` defaults (`singleDollarTextMath: true`):
    // a paragraph like `It costs $100 and saves $200` is parsed as
    // `inlineMath("100 and saves ")` followed by trailing text. This matches
    // GitHub / Pandoc / Jupyter behaviour — users who literally mean a
    // dollar sign must escape it as `\$` (see escape tests below) or wrap
    // the price in inline code (`` `$100` ``). We pin this behaviour here
    // so that anyone disabling `singleDollarTextMath` in the future
    // intentionally re-decides the trade-off.
    const html = renderMarkdown('It costs $100 and saves $200');
    expect(html).toMatch(/class="katex"/);
    // The TeX source `100 and saves ` ends up inside KaTeX's MathML
    // <annotation encoding="application/x-tex"> output — pinning the exact
    // boundary makes a regression on the boundary visible.
    expect(html).toContain('100 and saves');
    // `200` falls outside the inline math span as trailing plain text.
    expect(html).toContain('200');
  });

  test('inline code protects `$` from being parsed as math', () => {
    const html = renderMarkdown('Use `$100` for the price');
    // Should be a <code> element, never a math span.
    expect(html).toContain('<code>$100</code>');
    expect(html).not.toMatch(/class="katex"/);
  });

  test('escaped `\\$` is rendered as a literal dollar sign', () => {
    const html = renderMarkdown('Cost: \\$100 only');
    expect(html).not.toMatch(/class="katex"/);
    expect(html).toContain('$100');
  });

  test('escaping every `$` neutralises the two-dollar math match', () => {
    const html = renderMarkdown('Cost: \\$100 and \\$200 escaped');
    expect(html).not.toMatch(/class="katex"/);
    expect(html).toContain('$100');
    expect(html).toContain('$200');
  });

  test('fenced code block content is not parsed as math', () => {
    const html = renderMarkdown('```\nlet price = $100;\nlet total = $200;\n```');
    expect(html).not.toMatch(/class="katex"/);
    expect(html).toContain('$100');
    expect(html).toContain('$200');
  });
});

describe('MarkdownRenderer CJK emphasis', () => {
  test('bold adjacent to CJK full-width parenthesis renders as <strong>', () => {
    // CJK adjacency test: closing ** preceded by full-width ）, followed by CJK
    const html = renderMarkdown(
      '**Luma の現行モデルは Ray3.2（2026年6月リリース・Ray2 は Luma 自身が deprecated 扱い）**で、'
    );
    expect(html).toContain('<strong>');
    expect(html).not.toContain('**');
  });

  test('bold followed directly by CJK character (no space) renders as <strong>', () => {
    // CJK adjacency test: bold markers directly adjacent to CJK without space
    const html = renderMarkdown('これは**重要な**情報です');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('**');
  });

  test('bold preceded directly by CJK character (no space) renders as <strong>', () => {
    // CJK adjacency test: opening ** directly after CJK
    const html = renderMarkdown('日本語**テスト**だよ');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('**');
  });

  test('italic adjacent to CJK renders as <em>', () => {
    // CJK adjacency test: emphasis markers adjacent to CJK
    const html = renderMarkdown('これは*斜体*のテスト');
    expect(html).toContain('<em>');
    expect(html).not.toContain('*斜体*');
  });

  test('bold with full-width punctuation inside, followed by CJK', () => {
    // CJK adjacency test: closing ** after full-width 。 followed by CJK
    const html = renderMarkdown('**注意：これは重要。**次に進む');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('**');
  });

  test('GFM strikethrough adjacent to CJK renders as <del>', () => {
    // CJK adjacency test: strikethrough markers adjacent to CJK
    const html = renderMarkdown('これは~~削除~~されたテキスト');
    expect(html).toContain('<del>');
    expect(html).not.toContain('~~');
  });

  test('multiple bold segments in CJK text all render correctly', () => {
    // CJK adjacency test: multiple bold segments within CJK prose
    const html = renderMarkdown('**最初**と**次**と**最後**の三つ');
    const strongCount = (html.match(/<strong>/g) || []).length;
    expect(strongCount).toBe(3);
    expect(html).not.toContain('**');
  });
});
