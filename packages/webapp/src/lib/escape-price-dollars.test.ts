import { describe, expect, test } from 'vitest';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { escapePriceDollars } from './escape-price-dollars';

const REHYPE_KATEX_OPTIONS = { errorColor: 'currentColor' } as const;

function renderMarkdown(markdown: string): string {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeKatex, REHYPE_KATEX_OPTIONS)
    .use(rehypeStringify)
    .processSync(markdown)
    .toString();
}

describe('escapePriceDollars', () => {
  // -- Real-world examples that demonstrate the price-dollar pairing bug --

  const EXAMPLE_1 =
    'Redrawing artwork A costs **+$0.21~0.25** extra, but the approved \\$7 budget is nearly spent (approx $6.86), so overage approval is needed.';

  const EXAMPLE_2 = 'Approve new tranche **$1.00** (separate from old $0.60 budget; CALLS.jsonl continues appending).';

  const EXAMPLE_3 =
    'Spent $0.52 / remaining $0.08. Next step self-assessed as no arbitration needed: **$0 deterministic clone to create plate first**';

  const EXAMPLE_4 = 'Spent **$0.59 / budget $0.60 / remaining $0.01** — no further generation allowed.';

  describe('without preprocessor — demonstrates the bug', () => {
    test('example 1: unescaped $0.21 and $6.86 form spurious math pair', () => {
      const html = renderMarkdown(EXAMPLE_1);
      expect(html).toMatch(/katex/);
    });

    test('example 2: $1.00 and $0.60 form spurious math pair', () => {
      const html = renderMarkdown(EXAMPLE_2);
      expect(html).toMatch(/katex/);
    });

    test('example 3: $0.52 and $0.08 form spurious math pair', () => {
      const html = renderMarkdown(EXAMPLE_3);
      expect(html).toMatch(/katex/);
    });

    test('example 4: multiple price dollars form spurious math', () => {
      const html = renderMarkdown(EXAMPLE_4);
      expect(html).toMatch(/katex/);
    });
  });

  describe('with preprocessor — prices are literal, math is preserved', () => {
    test('example 1: prices render as literal text, no spurious math', () => {
      const processed = escapePriceDollars(EXAMPLE_1);
      const html = renderMarkdown(processed);
      expect(html).not.toMatch(/class="katex"/);
      expect(html).toContain('$0.21');
      expect(html).toContain('$7');
      expect(html).toContain('$6.86');
    });

    test('example 2: prices render as literal text', () => {
      const processed = escapePriceDollars(EXAMPLE_2);
      const html = renderMarkdown(processed);
      expect(html).not.toMatch(/class="katex"/);
      expect(html).toContain('$1.00');
      expect(html).toContain('$0.60');
    });

    test('example 3: prices render as literal text', () => {
      const processed = escapePriceDollars(EXAMPLE_3);
      const html = renderMarkdown(processed);
      expect(html).not.toMatch(/class="katex"/);
      expect(html).toContain('$0.52');
      expect(html).toContain('$0.08');
      expect(html).toContain('$0');
    });

    test('example 4: prices render as literal text', () => {
      const processed = escapePriceDollars(EXAMPLE_4);
      const html = renderMarkdown(processed);
      expect(html).not.toMatch(/class="katex"/);
      expect(html).toContain('$0.59');
      expect(html).toContain('$0.60');
      expect(html).toContain('$0.01');
    });
  });

  describe('real math is preserved (C-2 fixes)', () => {
    test('inline math $E=mc^2$ still renders as KaTeX', () => {
      const processed = escapePriceDollars('Inline: $E=mc^2$ here');
      const html = renderMarkdown(processed);
      expect(html).toMatch(/class="katex"/);
      expect(html).toContain('E=mc^2');
    });

    test('block math $$...$$ still renders', () => {
      const input = '$$\n\\sum_{i=1}^n i\n$$';
      const processed = escapePriceDollars(input);
      const html = renderMarkdown(processed);
      expect(html).toMatch(/class="katex-display"/);
    });

    test('math starting with digit followed by backslash: $2\\pi r$ is preserved', () => {
      const processed = escapePriceDollars('Circle: $2\\pi r$ is circumference');
      const html = renderMarkdown(processed);
      expect(html).toMatch(/class="katex"/);
    });

    test('math starting with digit followed by plus: $2+2=4$ is preserved', () => {
      const processed = escapePriceDollars('Simple: $2+2=4$ math');
      const html = renderMarkdown(processed);
      expect(html).toMatch(/class="katex"/);
    });

    test('display math with digits inside: $$12+3$$ is preserved', () => {
      const processed = escapePriceDollars('Result: $$12+3$$');
      const html = renderMarkdown(processed);
      expect(html).toMatch(/class="katex"/);
    });

    test('math like $n$ is preserved', () => {
      const processed = escapePriceDollars('For $n$ items');
      const html = renderMarkdown(processed);
      expect(html).toMatch(/class="katex"/);
    });

    test('math $3x + 2$ is preserved (digit followed by letter = math variable)', () => {
      const processed = escapePriceDollars('Calculate $3x + 2$ now');
      // $3 followed by 'x' (alphabetic) = math variable, not escaped
      expect(processed).not.toContain('\\$3');
      const html = renderMarkdown(processed);
      expect(html).toMatch(/class="katex"/);
    });

    // Known limitation: $3 x + 2$ (digit, space, then math) is indistinguishable
    // from a price. Agents should start math with a letter or `\`.
    test('known limitation: $3 x + 2$ is treated as price (agents should use \\3 or 3x)', () => {
      const processed = escapePriceDollars('Value $3 x + 2$ end');
      // $3 matches price pattern (digit followed by space, not math-continuation)
      expect(processed).toContain('\\$3');
    });
  });

  describe('C-3: expanded numeric patterns', () => {
    test('$100k is escaped as price', () => {
      const processed = escapePriceDollars('Costs $100k to build');
      expect(processed).toContain('\\$100k');
    });

    test('$1,000 is escaped as price', () => {
      const processed = escapePriceDollars('Price is $1,000 total');
      expect(processed).toContain('\\$1,000');
    });

    test('$2.5M is escaped as price', () => {
      const processed = escapePriceDollars('Revenue $2.5M this quarter');
      expect(processed).toContain('\\$2.5M');
    });

    test('$100k~$200k range is escaped', () => {
      const processed = escapePriceDollars('Budget $100k~$200k range');
      expect(processed).toContain('\\$100k');
      expect(processed).toContain('\\$200k');
    });

    test('$1,234.56 is escaped as price', () => {
      const processed = escapePriceDollars('Total $1,234.56 billed');
      expect(processed).toContain('\\$1,234.56');
    });

    test('$500B is escaped as price', () => {
      const processed = escapePriceDollars('Market cap $500B');
      expect(processed).toContain('\\$500B');
    });
  });

  describe('C-1: code blocks with special replacement patterns', () => {
    test('inline code containing $$ is preserved exactly', () => {
      const input = 'Use `$$` for display math';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
      const html = renderMarkdown(processed);
      expect(html).toContain('<code>$$</code>');
    });

    test('inline code containing $& is preserved exactly', () => {
      const input = 'The pattern `$&` matches the whole match';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
      const html = renderMarkdown(processed);
      expect(html).toContain('<code>');
      expect(html).toContain('$');
    });

    test("inline code containing $' is preserved exactly", () => {
      const input = "Use `$'` for the string after match";
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
      const html = renderMarkdown(processed);
      expect(html).toContain('<code>');
      expect(html).toContain('$');
    });

    test('inline code containing $` is preserved exactly', () => {
      const input = 'Use `$\\`` for the string before match';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
    });

    test('fenced code block with $$ is untouched', () => {
      const input = '```js\nconst x = `$$`;\n```';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
    });

    test('fenced code block with $& is untouched', () => {
      const input = '```js\nstr.replace(/a/, "$&b");\n```';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
    });

    test("fenced code block with $' is untouched", () => {
      const input = '```js\nstr.replace(/a/, "$\'");\n```';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
    });

    test('fenced code block with $100 is untouched', () => {
      const input = '```bash\necho $100\nlet total = $200;\n```';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
    });

    test('inline code with $VAR is untouched', () => {
      const input = 'The variable `$1` is special';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
    });
  });

  describe('W-1: unclosed fenced code block (streaming)', () => {
    test('unclosed fence protects everything after it', () => {
      const input = 'Text before\n```python\nprint($100)\nx = $200\n';
      const processed = escapePriceDollars(input);
      // The unclosed fence should protect $100 and $200 from being escaped
      expect(processed).toContain('$100');
      expect(processed).toContain('$200');
      expect(processed).not.toContain('\\$100');
      expect(processed).not.toContain('\\$200');
    });

    test('unclosed fence with tilde', () => {
      const input = 'Before\n~~~bash\necho $50\n';
      const processed = escapePriceDollars(input);
      expect(processed).toContain('$50');
      expect(processed).not.toContain('\\$50');
    });

    test('text before unclosed fence is still processed', () => {
      const input = 'Price is $100 total\n```python\necho $200\n';
      const processed = escapePriceDollars(input);
      expect(processed).toContain('\\$100');
      expect(processed).not.toContain('\\$200');
    });
  });

  describe('W-3: paragraph-spanning backtick prevention', () => {
    test('backticks on different lines do not form code span', () => {
      const input = 'Price `starts here\n\nand $100 ends` here';
      const processed = escapePriceDollars(input);
      // $100 should be escaped because backticks spanning paragraphs
      // are NOT treated as inline code
      expect(processed).toContain('\\$100');
    });

    test('backtick on one line does not pair with backtick on next line', () => {
      const input = 'See `$50 on first line\nand $100` on second';
      const processed = escapePriceDollars(input);
      // Newline breaks inline code span matching, so both should be escaped
      expect(processed).toContain('\\$50');
      expect(processed).toContain('\\$100');
    });
  });

  describe('already-escaped dollars are not double-escaped', () => {
    test('\\$7 stays as \\$7', () => {
      const input = 'Budget: \\$7 remaining';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
    });

    test('mixed escaped and unescaped', () => {
      const input = 'Spent $0.21, budget \\$7';
      const processed = escapePriceDollars(input);
      expect(processed).toContain('\\$0.21');
      expect(processed).toContain('\\$7');
      expect(processed).not.toContain('\\\\$7');
    });
  });

  describe('edge cases', () => {
    test('$0 followed by space is escaped', () => {
      const processed = escapePriceDollars('Cost is $0 here');
      expect(processed).toContain('\\$0');
    });

    test('$0 at end of string is escaped', () => {
      const processed = escapePriceDollars('Cost is $0');
      expect(processed).toContain('\\$0');
    });

    test('dollar in URL is not affected (no digit after)', () => {
      const input = 'See https://example.com/path';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
    });

    test('$$ display math delimiter is not touched', () => {
      const input = '$$x + y = z$$';
      const processed = escapePriceDollars(input);
      expect(processed).toBe(input);
    });

    test('math with digit and equals: $2=1+1$ is preserved', () => {
      const processed = escapePriceDollars('Check: $2=1+1$');
      // 2 followed by = is math continuation
      expect(processed).not.toContain('\\$2');
    });

    test('math with digit and caret: $2^{10}$ is preserved', () => {
      const processed = escapePriceDollars('Value: $2^{10}$');
      expect(processed).not.toContain('\\$2');
    });

    test('math with digit and underscore: $2_{max}$ is preserved', () => {
      const processed = escapePriceDollars('Index: $2_{max}$');
      expect(processed).not.toContain('\\$2');
    });

    // $2-1$ is now treated as price (- is not math continuation; use \frac{} or (2-1) instead)
    test('known limitation: $2-1$ is treated as price (agents should use letter-start)', () => {
      const processed = escapePriceDollars('Calc: $2-1$');
      expect(processed).toContain('\\$2');
    });

    test('math with digit and star: $2*3$ is preserved', () => {
      const processed = escapePriceDollars('Mul: $2*3$');
      expect(processed).not.toContain('\\$2');
    });

    // $2/3$ is now treated as price (/ is not math continuation; use \frac{2}{3} instead)
    test('known limitation: $2/3$ is treated as price (agents should use \\frac)', () => {
      const processed = escapePriceDollars('Div: $2/3$');
      expect(processed).toContain('\\$2');
    });
  });

  describe('R-1: price patterns with - and / are escaped', () => {
    // CJK adjacency: tests slash-price next to CJK characters
    test('slash price adjacent to CJK chars is escaped, already-escaped preserved', () => {
      const input = '1回あたり$0.60/回で、合計\\$1.20になるにゃ';
      const processed = escapePriceDollars(input);
      expect(processed).toContain('\\$0.60');
      expect(processed).not.toContain('\\\\$1.20');
    });

    // CJK adjacency: tests dash-range prices surrounded by CJK text
    test('dash-range prices surrounded by CJK text are escaped', () => {
      const input = '予算$100-200（残り$50-60）で対応';
      const processed = escapePriceDollars(input);
      expect(processed).toContain('\\$100');
      expect(processed).toContain('\\$50');
    });

    // CJK adjacency: slash-price in CJK context must not pair with later \$ as math
    test('slash price in CJK context does not pair with later escaped dollar as math', () => {
      const input = '消費$0.60/回で計算。予算は\\$7枠にゃ。';
      const processed = escapePriceDollars(input);
      const html = renderMarkdown(processed);
      expect(html).not.toMatch(/class="katex"/);
    });

    test('$100-$200 range is fully escaped', () => {
      const input = 'Budget $100-$200 range';
      const processed = escapePriceDollars(input);
      expect(processed).toContain('\\$100');
      expect(processed).toContain('\\$200');
    });
  });

  describe('L-1: indented fenced code blocks (0-3 spaces, CommonMark spec)', () => {
    test('list-nested ```bash with awk $1 is protected', () => {
      const input = '- Run this:\n   ```bash\n   awk $1 file.txt\n   echo $200\n   ```\nCost $50 total';
      const processed = escapePriceDollars(input);
      // Inside indented fence: protected
      expect(processed).not.toContain('\\$1');
      expect(processed).not.toContain('\\$200');
      // Outside fence: escaped
      expect(processed).toContain('\\$50');
    });

    test('2-space indented fence is detected', () => {
      const input = '  ```python\n  x = $100\n  ```\nPrice $30';
      const processed = escapePriceDollars(input);
      expect(processed).not.toContain('\\$100');
      expect(processed).toContain('\\$30');
    });

    test('3-space indented fence is detected (max allowed)', () => {
      const input = '   ```js\n   let cost = $250;\n   ```\nBudget $80';
      const processed = escapePriceDollars(input);
      expect(processed).not.toContain('\\$250');
      expect(processed).toContain('\\$80');
    });

    test('4-space indent is NOT treated as fence (known limitation)', () => {
      const input = '    ```bash\n    echo $100\n    ```\nPrice $50';
      const processed = escapePriceDollars(input);
      // 4 spaces = not a fence, so $100 gets escaped (known limitation)
      expect(processed).toContain('\\$100');
      expect(processed).toContain('\\$50');
    });

    test('indented closing fence also detected', () => {
      const input = '```bash\necho $100\n   ```\nPrice $50';
      const processed = escapePriceDollars(input);
      expect(processed).not.toContain('\\$100');
      expect(processed).toContain('\\$50');
    });
  });

  describe('W-b: plus sign lookahead for price vs math', () => {
    test('$2M+ round is treated as price (+ followed by space)', () => {
      const input = 'Series A raised $2M+ and targeting \\$5M next';
      const processed = escapePriceDollars(input);
      expect(processed).toContain('\\$2M');
      expect(processed).not.toContain('\\\\$5M');
    });

    // CJK adjacency: + followed by CJK character means price, not math
    test('plus sign followed by CJK character is treated as price', () => {
      const input = '月$100+かかる（残り$80）';
      const processed = escapePriceDollars(input);
      expect(processed).toContain('\\$100');
      expect(processed).toContain('\\$80');
      const html = renderMarkdown(processed);
      expect(html).not.toMatch(/class="katex"/);
    });

    test('$100+ at end of string is price', () => {
      const processed = escapePriceDollars('Budget is $100+');
      expect(processed).toContain('\\$100');
    });

    test('$2+2=4$ is still math (+ followed by digit)', () => {
      const processed = escapePriceDollars('Simple: $2+2=4$ math');
      expect(processed).not.toContain('\\$2');
      const html = renderMarkdown(processed);
      expect(html).toMatch(/class="katex"/);
    });

    test('$2+x$ is still math (+ followed by letter)', () => {
      const processed = escapePriceDollars('Expr: $2+x$ end');
      expect(processed).not.toContain('\\$2');
    });
  });

  describe('F-1: longer closing fence is recognized', () => {
    test('```` closing ``` block — longer fence correctly closes', () => {
      const input = '```js\nconst x = $100;\n````\nPrice is $50 here';
      const processed = escapePriceDollars(input);
      // $100 inside the fence is protected
      expect(processed).not.toContain('\\$100');
      // $50 outside the fence is escaped
      expect(processed).toContain('\\$50');
    });

    test('```` opening with ````` closing', () => {
      const input = '````python\ny = $200\n`````\nCost $30 total';
      const processed = escapePriceDollars(input);
      expect(processed).not.toContain('\\$200');
      expect(processed).toContain('\\$30');
    });

    test('~~~~ closing ~~~ block', () => {
      const input = '~~~bash\necho $99\n~~~~\nBill $10';
      const processed = escapePriceDollars(input);
      expect(processed).not.toContain('\\$99');
      expect(processed).toContain('\\$10');
    });

    test('shorter fence does NOT close the block', () => {
      const input = '````js\nconst x = $100;\n```\nstill inside $200\n````\nPrice $50';
      const processed = escapePriceDollars(input);
      // Both $100 and $200 are inside the fence (``` doesn't close ```` )
      expect(processed).not.toContain('\\$100');
      expect(processed).not.toContain('\\$200');
      // $50 is outside
      expect(processed).toContain('\\$50');
    });
  });
});
