'use client';

import { useLocale } from 'next-intl';
import { formatDate, formatDateTime, formatTime } from '@/lib/utils';
import { useMounted } from '@/hooks/use-mounted';

interface LocalDateTimeProps {
  timestamp: number | Date;
  format?: 'date' | 'time' | 'datetime';
  className?: string;
}

/**
 * Renders a date/time in the viewer's local timezone WITHOUT causing a
 * hydration mismatch.
 *
 * formatDate/formatTime use the runtime's local timezone, so the server
 * (Lambda, UTC) and the browser (e.g. JST) produce different strings for the
 * same timestamp. Rendering them during SSR made React throw hydration error
 * #418 on every page load and re-render the whole tree client-side. This
 * component renders a placeholder on the server and the first client render,
 * then fills in the local-time string after mount, so both passes match.
 */
export default function LocalDateTime({ timestamp, format = 'datetime', className }: LocalDateTimeProps) {
  const locale = useLocale();
  const mounted = useMounted();

  if (!mounted) {
    return <span className={className}>{'\u00A0'}</span>;
  }

  const date = typeof timestamp === 'number' ? new Date(timestamp) : timestamp;
  const localeForDate = locale === 'ja' ? 'ja-JP' : 'en-US';
  const text =
    format === 'date'
      ? formatDate(date, localeForDate)
      : format === 'time'
        ? formatTime(date)
        : formatDateTime(date, localeForDate);

  return <span className={className}>{text}</span>;
}
