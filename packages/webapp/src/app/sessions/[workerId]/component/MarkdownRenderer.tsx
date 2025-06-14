import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import { useTheme } from 'next-themes';

type MarkdownRendererProps = {
  content: string;
};

export const MarkdownRenderer = ({ content }: MarkdownRendererProps) => {
  const { resolvedTheme } = useTheme();

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => {
          if (typeof children === 'string') {
            const parts = children.split('\n');
            return (
              <p className="mb-2">
                {parts.map((part, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <br />}
                    {part}
                  </React.Fragment>
                ))}
              </p>
            );
          }
          return <p className="mb-2">{children}</p>;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code(props: any) {
          const { className, children } = props;
          const match = /language-(\w+)/.exec(className || '');
          const isInline = !match;
          return !isInline ? (
            <SyntaxHighlighter
              style={resolvedTheme === 'dark' ? oneDark : oneLight}
              lineProps={{ style: { wordBreak: 'break-word', whiteSpace: 'pre-wrap' } }}
              language={match[1]}
              PreTag="div"
              className="rounded-md"
              wrapLines
              wrapLongLines
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
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
        li: ({ children }) => <li className="ml-2">{children}</li>,
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
      }}
    >
      {content}
    </ReactMarkdown>
  );
};
