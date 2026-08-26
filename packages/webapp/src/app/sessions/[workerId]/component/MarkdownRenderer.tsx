import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { useTheme } from 'next-themes';
import type { PluggableList } from 'unified';
import { MermaidDiagram } from './MermaidDiagram';
import { KatexScrollContainer } from './KatexScrollContainer';
import { usePortMapping } from './PortMappingContext';
import { rewriteMdastLocalhostUrls, type MdastNode, type PortMapping } from '@/lib/port-url-transform';
import { escapePriceDollars } from '@/lib/escape-price-dollars';

type MarkdownRendererProps = {
  content: string;
};

// Render KaTeX parse errors in the surrounding text color (instead of the
// default red) so that streaming partial block math like `$$\sum_{i=1}^n`
// doesn't flash red on every new token. `trust` stays at its safe default
// of false — never enable: it would allow user-controlled HTML/JS via
// `\href` and similar primitives. Inline math `$...$` and block math
// `$$...$$` use `remark-math`'s defaults (singleDollarTextMath: true) so
// that GitHub-/Pandoc-/Jupyter-compatible syntax works out of the box.
const REHYPE_KATEX_OPTIONS = {
  errorColor: 'currentColor',
} as const;

/**
 * remark plugin that, when the given ref holds a mapping, rewrites
 * localhost:PORT references inside text nodes into link nodes. The walker
 * itself lives in `@/lib/port-url-transform` so it can be unit-tested with
 * hand-written mdast fragments (no React / react-markdown needed).
 *
 * The mapping is read through a ref so a fresh plugin instance doesn't have
 * to be built every time the port mapping updates — callers can keep a
 * stable plugin array across renders.
 */
function remarkRewriteLocalhostUrls(mappingRef: React.RefObject<PortMapping | null>) {
  return () => (tree: unknown) => {
    rewriteMdastLocalhostUrls(tree as MdastNode, mappingRef.current);
  };
}

function containsKatex(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some((child) => {
    if (!React.isValidElement(child)) return false;
    const props = child.props as Record<string, unknown>;
    const cn = typeof props.className === 'string' ? props.className : '';
    if (cn.includes('katex')) return true;
    if (props.children) return containsKatex(props.children as React.ReactNode);
    return false;
  });
}

export const MarkdownRenderer = React.memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const { resolvedTheme } = useTheme();
  // resolvedTheme is undefined during SSR but resolved on the client, so a
  // theme-dependent code style mismatches between the two renders (hydration
  // error #418). Stay on the light style until mounted, then switch.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);
  const portMapping = usePortMapping();
  const portMappingRef = React.useRef<PortMapping | null>(portMapping);
  // Sync the ref DURING render (intentionally, not in an effect). This
  // component reads `usePortMapping()` so it re-renders whenever the port
  // mapping changes, and `react-markdown` re-parses `content` on that
  // render, reading `portMappingRef.current` lazily via the stable plugin
  // below. An effect-based sync would leave the ref one commit behind
  // (effects run after render), and because no further render is scheduled
  // — and `react-markdown` 10.x has no internal memo — the localhost links
  // in already-rendered messages would never pick up a new preview URL
  // after openPort. The alternative of memoizing the plugin array on
  // [portMapping] would force a re-parse of every message on each mapping
  // change, which is wasteful for long chat history.
  // eslint-disable-next-line react-hooks/refs
  portMappingRef.current = portMapping;
  const codeStyle =
    mounted && resolvedTheme === 'dark'
      ? oneDark
      : {
          ...oneLight,
          'pre[class*="language-"]': { ...oneLight['pre[class*="language-"]'], background: '#e5e7eb' },
          'code[class*="language-"]': { ...oneLight['code[class*="language-"]'], background: '#e5e7eb' },
        };

  // Stable plugin array: the localhost-rewriter reads the current mapping
  // through `portMappingRef`, so the array itself never needs to change.
  const remarkPlugins = React.useMemo<PluggableList>(
    () => [
      remarkGfm,
      remarkCjkFriendly,
      remarkCjkFriendlyGfmStrikethrough,
      remarkMath,
      // Intentionally passing the ref itself (not its value): the plugin
      // reads `.current` lazily so the stable plugin array can see the
      // latest mapping without rebuilding (and re-parsing all messages).
      // eslint-disable-next-line react-hooks/refs
      remarkRewriteLocalhostUrls(portMappingRef),
    ],
    []
  );
  const rehypePlugins = React.useMemo<PluggableList>(() => [[rehypeKatex, REHYPE_KATEX_OPTIONS]], []);

  const processedContent = React.useMemo(() => escapePriceDollars(content), [content]);

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={{
        p: ({ children }) => {
          if (containsKatex(children)) {
            return (
              <KatexScrollContainer tag="p" className="mb-2">
                {children}
              </KatexScrollContainer>
            );
          }
          if (typeof children === 'string') {
            const parts = children.split('\n');
            return (
              <p className="mb-2 overflow-x-auto">
                {parts.map((part, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <br />}
                    {part}
                  </React.Fragment>
                ))}
              </p>
            );
          }
          return <p className="mb-2 overflow-x-auto">{children}</p>;
        },
        code(props: any) {
          const { className, children } = props;
          const match = /language-(\w+)/.exec(className || '');
          const childStr = String(children);
          const isBlock = !!match || childStr.includes('\n');

          if (match?.[1] === 'mermaid') {
            return <MermaidDiagram chart={childStr.replace(/\n$/, '')} />;
          }

          return isBlock ? (
            <div className="overflow-x-auto mb-2 rounded-md" data-scrollable="true">
              <SyntaxHighlighter style={codeStyle} language={match?.[1] || 'text'} PreTag="div" className="rounded-md">
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            </div>
          ) : (
            <code className="bg-gray-200 dark:bg-gray-600 px-1 py-0.5 rounded text-sm whitespace-pre-wrap">
              {children}
            </code>
          );
        },
        h1: ({ children }) => <h1 className="text-2xl font-bold mb-4">{children}</h1>,
        h2: ({ children }) => <h2 className="text-xl font-bold mb-3">{children}</h2>,
        h3: ({ children }) => <h3 className="text-lg font-bold mb-2">{children}</h3>,

        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
        li: ({ children }) =>
          containsKatex(children) ? (
            <KatexScrollContainer tag="li" className="ml-2">
              {children}
            </KatexScrollContainer>
          ) : (
            <li className="ml-2 overflow-x-auto">{children}</li>
          ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic mb-2">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-blue-600 dark:text-blue-400 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
        strong: ({ children }) => <strong className="font-bold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        table: ({ children }) => (
          <div className="overflow-x-auto mb-2" data-scrollable="true">
            <table className="border-collapse border border-gray-300 dark:border-gray-600">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-gray-100 dark:bg-gray-700">{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-b border-gray-300 dark:border-gray-600">{children}</tr>,
        th: ({ children }) => (
          <th className="border border-gray-300 dark:border-gray-600 px-3 py-2 text-left font-semibold text-sm whitespace-nowrap">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm whitespace-nowrap">
            {children}
          </td>
        ),
      }}
    >
      {processedContent}
    </ReactMarkdown>
  );
});
