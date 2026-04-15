import { basename, extname } from 'path';

export const getAttachedImageKey = (workerId: string, toolUseId: string, filePath: string) => {
  const ext = extname(filePath);
  return `${workerId}/${toolUseId}${ext}`;
};

export const getAttachedFileKey = (workerId: string, toolUseId: string, filePath: string) => {
  const fileName = basename(filePath);
  return `${workerId}/${toolUseId}/${fileName}`;
};

export const isImageKey = (key: string): boolean => {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif'];
  return imageExtensions.some((ext) => key.toLowerCase().endsWith(ext));
};
