import React from 'react';

type UrlRendererProps = {
  content: string;
};

export const UrlRenderer = ({ content }: UrlRendererProps) => {
  // Regular expression to detect URLs
  const urlRegex = /(https?:\/\/[^\s]+)/g;

  // Split text into URL and non-URL parts
  const parts = content.split(urlRegex);
  const matches = content.match(urlRegex) || [];

  // Arrange matched and unmatched parts alternately
  const elements: React.ReactNode[] = [];

  parts.forEach((part, i) => {
    if (part.match(urlRegex)) {
      // Display as a link if it's a URL
      elements.push(
        <a
          key={i}
          href={part}
          className="text-blue-600 dark:text-blue-400 hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          {part}
        </a>
      );
    } else {
      // For regular text content
      const lines = part.split('\n');
      elements.push(
        <React.Fragment key={i}>
          {lines.map((line, j) => (
            <React.Fragment key={`${i}-${j}`}>
              {j > 0 && <br />}
              {line}
            </React.Fragment>
          ))}
        </React.Fragment>
      );
    }
  });

  return <div className="whitespace-pre-wrap">{elements}</div>;
};
