import { extname } from 'path';

export const getAttachedImageKey = (workerId: string, toolUseId: string, filePath: string) => {
  const ext = extname(filePath);
  return `${workerId}/${toolUseId}${ext}`;
};
