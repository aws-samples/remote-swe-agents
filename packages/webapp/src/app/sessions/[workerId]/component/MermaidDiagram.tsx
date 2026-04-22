'use client';

import React, { useEffect, useRef, useState } from 'react';
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
  const idRef = useRef(getUniqueId());
  const uniqueId = idRef.current;
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
    return (
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4 mb-2">
        <p className="text-red-600 dark:text-red-400 text-sm">Mermaid diagram error: {error}</p>
        <pre className="text-xs mt-2 text-gray-600 dark:text-gray-400 overflow-x-auto">{chart}</pre>
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
