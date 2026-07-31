import { describe, expect, test } from 'vitest';
import { validateMermaidInText, buildMermaidFeedback } from './mermaid-validator';

describe('validateMermaidInText', () => {
  test('returns valid when no mermaid blocks present', async () => {
    const result = await validateMermaidInText('Hello world, no diagrams here.');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('returns valid for correct flowchart', async () => {
    const text = `Here is a diagram:
\`\`\`mermaid
graph TD
    A[Start] --> B[End]
\`\`\`
Done.`;
    const result = await validateMermaidInText(text);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('returns valid for correct sequence diagram', async () => {
    const text = `\`\`\`mermaid
sequenceDiagram
    Alice->>Bob: Hello
    Bob-->>Alice: Hi
\`\`\``;
    const result = await validateMermaidInText(text);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('returns invalid for broken syntax', async () => {
    const text = `\`\`\`mermaid
graph TD
    A --> B
    C --> invalid syntax here %%%
    D[
\`\`\``;
    const result = await validateMermaidInText(text);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('returns invalid when one of multiple blocks is broken', async () => {
    const text = `Valid:
\`\`\`mermaid
graph TD
    A --> B
\`\`\`

Broken:
\`\`\`mermaid
sequenceDiagram
    Alice->Bob Hello
    invalid %%% syntax
\`\`\``;
    const result = await validateMermaidInText(text);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('ignores non-mermaid code blocks', async () => {
    const text = `\`\`\`javascript
const x = 1;
\`\`\`

\`\`\`python
print("hello")
\`\`\``;
    const result = await validateMermaidInText(text);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('ignores unclosed mermaid fences (partial/streaming)', async () => {
    const text = `\`\`\`mermaid
graph TD
    A --> B`;
    const result = await validateMermaidInText(text);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('buildMermaidFeedback', () => {
  test('produces feedback string with error details', () => {
    const errors = [{ chart: 'graph TD\n    A --> invalid', message: 'Parse error on line 2' }];
    const feedback = buildMermaidFeedback(errors);
    expect(feedback).toContain('[SYSTEM]');
    expect(feedback).toContain('invalid Mermaid diagram syntax');
    expect(feedback).toContain('1 diagram(s) failed validation');
    expect(feedback).toContain('Parse error on line 2');
    expect(feedback).toContain('A --> invalid');
  });

  test('handles multiple errors', () => {
    const errors = [
      { chart: 'graph TD\n    broken1', message: 'Error 1' },
      { chart: 'sequenceDiagram\n    broken2', message: 'Error 2' },
    ];
    const feedback = buildMermaidFeedback(errors);
    expect(feedback).toContain('2 diagram(s) failed validation');
    expect(feedback).toContain('Diagram 1');
    expect(feedback).toContain('Diagram 2');
  });
});
