'use client';

import { useTheme } from 'next-themes';
import { Sun, Moon, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();

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
        return 'ライトモード';
      case 'dark':
        return 'ダークモード';
      case 'system':
        return 'システム設定';
      default:
        return 'テーマ切り替え';
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycleTheme}
      className="w-9 h-9"
      title={getTooltip()}
    >
      {getIcon()}
    </Button>
  );
}
