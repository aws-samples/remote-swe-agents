'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, ToasterProps } from 'sonner';
import { useMounted } from '@/hooks/use-mounted';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();
  // useTheme() is undefined during SSR but returns the stored theme on the
  // client, so passing it before mount causes a hydration mismatch. Use the
  // deterministic default until mounted.
  const mounted = useMounted();

  return (
    <Sonner
      theme={mounted ? (theme as ToasterProps['theme']) : 'system'}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
