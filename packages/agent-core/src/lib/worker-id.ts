import { WorkerId } from '../env';

/**
 * Extracts worker ID from a text that contains the WORKER_ID metadata
 * @param text - The text to search
 * @returns The worker ID if found, null otherwise
 */
export const extractWorkerIdFromText = (text: string): string | null => {
  const match = text.match(/<!-- WORKER_ID:(.+) -->/);
  return match ? match[1] : null;
};

/**
 * Appends worker ID metadata to content (comments, PR descriptions, etc.)
 * @param content - The original content
 * @returns The content with worker ID metadata appended
 */
export const appendWorkerIdMetadata = (content: string, workerId = WorkerId): string => {
  return `${content}\n\n<!-- DO NOT EDIT: System generated metadata -->\n<!-- WORKER_ID:${workerId} -->`;
};
