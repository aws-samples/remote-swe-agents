'use client';

import { useState, useRef, ChangeEvent, useEffect } from 'react';
import { Loader2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { getUploadUrl } from '@/actions/upload/action';
import { getImageUrls } from '@/actions/image/action';

type AgentIconUploaderProps = {
  currentIconKey?: string;
  onIconKeyChange: (key: string) => void;
  disabled?: boolean;
  size?: number;
};

export default function AgentIconUploader({
  currentIconKey,
  onIconKeyChange,
  disabled = false,
  size = 80,
}: AgentIconUploaderProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (currentIconKey) {
      getImageUrls({ keys: [currentIconKey] }).then((result) => {
        if (result?.data && result.data.length > 0) {
          setPreviewUrl(result.data[0].url);
        }
      });
    }
  }, [currentIconKey]);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Please select a PNG, JPEG, or WebP image');
      return;
    }

    const localPreview = URL.createObjectURL(file);
    setPreviewUrl(localPreview);
    setIsUploading(true);

    try {
      const result = await getUploadUrl({
        contentType: file.type,
      });
      if (!result?.data || result?.validationErrors) {
        throw new Error('Failed to get upload URL');
      }

      const { url, key } = result.data;

      await fetch(url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });

      onIconKeyChange(key);
    } catch (error) {
      console.error('Icon upload failed:', error);
      toast.error('Failed to upload icon');
      setPreviewUrl(null);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl(null);
    onIconKeyChange('');
  };

  return (
    <div className="flex items-center gap-4">
      <div
        className="relative flex-shrink-0 rounded-full overflow-hidden border-2 border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center bg-gray-100 dark:bg-gray-700 cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
        style={{ width: size, height: size }}
        onClick={() => !disabled && fileInputRef.current?.click()}
      >
        {previewUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Agent icon" className="object-cover w-full h-full" />
            {isUploading && (
              <div className="absolute inset-0 bg-black bg-opacity-40 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-white" />
              </div>
            )}
          </>
        ) : (
          <Upload className="w-5 h-5 text-gray-400 dark:text-gray-500" />
        )}
      </div>
      {previewUrl && !isUploading && (
        <button
          type="button"
          onClick={handleRemove}
          disabled={disabled}
          className="text-sm text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 flex items-center gap-1"
        >
          <X className="w-3 h-3" />
          Remove
        </button>
      )}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        disabled={disabled}
      />
    </div>
  );
}
