'use client';

import React from 'react';
import { useScrollOverflow } from '@/hooks/use-scroll-overflow';

type KatexScrollContainerProps = {
  tag: 'p' | 'li';
  className?: string;
  children: React.ReactNode;
};

export function KatexScrollContainer({ tag: Tag, className, children }: KatexScrollContainerProps) {
  const ref = useScrollOverflow<HTMLElement>();
  return (
    <Tag
      ref={ref as React.Ref<HTMLParagraphElement & HTMLLIElement>}
      className={`${className ?? ''} overflow-x-auto katex-scroll-container`}
    >
      {children}
    </Tag>
  );
}
