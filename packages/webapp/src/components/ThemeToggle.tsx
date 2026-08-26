'use client';

import { useTheme } from 'next-themes';
import { Sun, Moon, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { useMounted } from '@/hooks/use-mounted';

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const t = useTranslations('theme');
  // useTheme() returns undefined during SSR but the stored theme on the
  // client, so rendering a theme-dependent icon before mount causes a
  // hydration mismatch (React #418). Render a stable placeholder until
  // mounted (the pattern recommended by next-themes).
  const mounted = useMounted();

  const cycleTheme = () => {
    if (theme === 'light') {
      setTheme('dark');
    } else if (theme === 'dark') {
      setTheme('system');
    } else {
      setTheme('light');
    }
  };

  const getIcon = () => {
    switch (theme) {
      case 'light':
        return <Sun className="h-4 w-4" />;
      case 'dark':
        return <Moon className="h-4 w-4" />;
      case 'system':
        return <Monitor className="h-4 w-4" />;
      default:
        return <Sun className="h-4 w-4" />;
    }
  };

  const getTooltip = () => {
    switch (theme) {
      case 'light':
        return t('light');
      case 'dark':
        return t('dark');
      case 'system':
        return t('system');
      default:
        return t('light');
    }
  };

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="w-9 h-9" aria-label={t('light')}>
        <Sun className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycleTheme}
      className="w-9 h-9"
      title={getTooltip()}
      suppressHydrationWarning={true}
    >
      {getIcon()}
    </Button>
  );
}
