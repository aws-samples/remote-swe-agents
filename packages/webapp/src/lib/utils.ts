import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a date consistently across all platforms (PC and mobile).
 * Returns date string like "2026/03/18" for ja-JP or "03/18/2026" for en-US.
 */
export function formatDate(date: Date, locale: string): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  if (locale === 'ja-JP') {
    return `${year}/${month}/${day}`;
  }
  return `${month}/${day}/${year}`;
}

/**
 * Format time consistently across all platforms (PC and mobile).
 * Returns time string like "15:30" (24-hour format).
 */
export function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Format date and time consistently across all platforms.
 * Returns string like "2026/03/18 15:30" for ja-JP or "03/18/2026 15:30" for en-US.
 */
export function formatDateTime(date: Date, locale: string): string {
  return `${formatDate(date, locale)} ${formatTime(date)}`;
}
