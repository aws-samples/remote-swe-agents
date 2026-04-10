'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, FileDown, FileText, FileArchive, FileSpreadsheet, FileCode, File } from 'lucide-react';
import { getFileUrls } from '@/actions/file/action';

type FileViewerProps = {
  fileKeys: string[];
};

type FileData = {
  key: string;
  url: string;
  fileName: string;
  loading: boolean;
  error: boolean;
};

const getFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) {
    return <FileText className="w-4 h-4 flex-shrink-0" />;
  }
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(ext)) {
    return <FileArchive className="w-4 h-4 flex-shrink-0" />;
  }
  if (['csv', 'xls', 'xlsx'].includes(ext)) {
    return <FileSpreadsheet className="w-4 h-4 flex-shrink-0" />;
  }
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'html', 'css', 'json', 'xml', 'yaml', 'yml', 'sh'].includes(ext)) {
    return <FileCode className="w-4 h-4 flex-shrink-0" />;
  }
  return <File className="w-4 h-4 flex-shrink-0" />;
};

const getFileName = (key: string): string => {
  const parts = key.split('/');
  return parts[parts.length - 1] || key;
};

export const FileViewer = ({ fileKeys }: FileViewerProps) => {
  const [files, setFiles] = useState<FileData[]>([]);
  const [fileCache, setFileCache] = useState<Map<string, FileData>>(new Map());

  useEffect(() => {
    const loadFiles = async () => {
      const currentFiles = fileKeys.map((key) => {
        const cached = fileCache.get(key);
        return cached ?? { key, url: '', fileName: getFileName(key), loading: true, error: false };
      });
      setFiles(currentFiles);

      try {
        const result = await getFileUrls({ keys: fileKeys });

        if (result?.data) {
          const newCache = new Map(fileCache);
          result.data.forEach((item) => {
            newCache.set(item.key, {
              key: item.key,
              url: item.url,
              fileName: getFileName(item.key),
              loading: false,
              error: false,
            });
          });
          setFileCache(newCache);

          setFiles(
            fileKeys.map((key) => {
              const cached = newCache.get(key);
              return cached || { key, url: '', fileName: getFileName(key), loading: false, error: true };
            })
          );
        }
      } catch (error) {
        console.error('Failed to load file URLs:', error);
        const newCache = new Map(fileCache);
        fileKeys.forEach((key) => {
          if (!newCache.has(key)) {
            newCache.set(key, { key, url: '', fileName: getFileName(key), loading: false, error: true });
          }
        });
        setFileCache(newCache);

        setFiles(
          fileKeys.map((key) => {
            const cached = newCache.get(key);
            return cached || { key, url: '', fileName: getFileName(key), loading: false, error: true };
          })
        );
      }
    };

    if (fileKeys.length > 0) {
      loadFiles();
    }
  }, [fileKeys]);

  if (fileKeys.length === 0) {
    return null;
  }

  return (
    <div className="mt-2">
      <div className="flex flex-col gap-1.5">
        {files.map((file) => (
          <div key={file.key}>
            {file.loading ? (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-md">
                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                <span className="text-sm text-gray-500">{file.fileName}</span>
              </div>
            ) : file.error ? (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-md">
                {getFileIcon(file.fileName)}
                <span className="text-sm text-gray-500">{file.fileName} (Error)</span>
              </div>
            ) : (
              <a
                href={file.url}
                download={file.fileName}
                className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors group"
              >
                {getFileIcon(file.fileName)}
                <span className="text-sm text-blue-600 dark:text-blue-400 group-hover:underline truncate max-w-xs">
                  {file.fileName}
                </span>
                <FileDown className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-500 flex-shrink-0" />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
