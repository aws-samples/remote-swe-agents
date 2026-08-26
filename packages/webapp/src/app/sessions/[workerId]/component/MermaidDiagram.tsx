'use client';

import React, { useEffect, useState } from 'react';
import mermaid from 'mermaid';
import { useTheme } from 'next-themes';

let currentTheme: string | undefined;
function ensureMermaidInitialized(theme: string) {
  if (currentTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      securityLevel: 'strict',
    });
    currentTheme = theme;
  }
}

let counter = 0;
function getUniqueId() {
  return `mermaid-${counter++}`;
}

type MermaidDiagramProps = {
  chart: string;
};

export const MermaidDiagram = React.memo(function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  // Lazy state initializer: `getUniqueId()` runs exactly once for the
  // component's lifetime and the id stays stable across renders. (The
  // previous `useRef(getUniqueId())` re-evaluated `getUniqueId()` — and
  // thus incremented the module counter — on every render, and read the
  // ref during render.)
  const [uniqueId] = useState(getUniqueId);
  const mermaidTheme = resolvedTheme === 'dark' ? 'dark' : 'default';

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        ensureMermaidInitialized(mermaidTheme);
        const { svg: renderedSvg } = await mermaid.render(uniqueId, chart);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (e) {
        const orphan = document.getElementById(`d${uniqueId}`);
        if (orphan) orphan.remove();
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to render mermaid diagram');
          setSvg('');
        }
      }
    };

    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [chart, mermaidTheme, uniqueId]);

  if (error) {
    // `react-markdown` wraps fenced code blocks in a default `<pre>` whose
    // browser-default `white-space: pre` is inherited by every descendant.
    // Without `whitespace-normal` here, the error `<p>` below would refuse
    // to wrap on long lines and blow past the chat bubble's `max-width`,
    // producing a page-level horizontal scroll on mobile. `max-w-full`
    // on the outer container plus `break-words` on the message and
    // `overflow-x-auto` on the chart `<pre>` keep the rendering inside
    // the bubble (chart scrolls internally when the diagram source is
    // wider than the bubble), matching the existing code-block / table
    // overflow pattern in `MarkdownRenderer`.
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4 mb-2 max-w-full whitespace-normal">
        <p className="text-red-600 dark:text-red-400 text-sm break-words">Mermaid diagram error: {error}</p>
        <pre className="text-xs mt-2 text-gray-600 dark:text-gray-400 overflow-x-auto max-w-full">{chart}</pre>
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto mb-2 rounded-md bg-white dark:bg-gray-800 p-4"
      data-scrollable="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});
