import React from 'react';

type UrlRendererProps = {
  content: string;
};

export const UrlRenderer = ({ content }: UrlRendererProps) => {
  // URLを検出するための正規表現
  const urlRegex = /(https?:\/\/[^\s]+)/g;

  // テキストをURLと非URLのパーツに分割
  const parts = content.split(urlRegex);
  const matches = content.match(urlRegex) || [];

  // マッチングした部分とマッチングしなかった部分を交互に配置
  const elements: React.ReactNode[] = [];

  parts.forEach((part, i) => {
    if (part.match(urlRegex)) {
      // URLの場合はリンクとして表示
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
      // 通常のテキストの場合
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
