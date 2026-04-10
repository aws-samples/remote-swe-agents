'use client';

import { useState, useRef, ChangeEvent, useEffect, ClipboardEvent } from 'react';
import { Loader2, X, FileDown } from 'lucide-react';
import { toast } from 'sonner';
import { getUploadUrl } from '@/actions/upload/action';
import Image from 'next/image';

export type UploadedImage = {
  id: string;
  file: File;
  previewUrl: string;
  key?: string; // undefined means it is being uploaded
};

export type UploadedFile = {
  id: string;
  file: File;
  fileName: string;
  key?: string; // undefined means it is being uploaded
  isImage: boolean;
};

type ImageUploaderProps = {
  workerId?: string;
  onImagesChange: (imageKeys: string[]) => void;
  onFilesChange?: (fileKeys: string[]) => void;
  onPasteOverride?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
};

export default function ImageUploader({ workerId, onImagesChange, onFilesChange, onPasteOverride }: ImageUploaderProps) {
  const [uploadingImages, setUploadingImages] = useState<UploadedImage[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generalFileInputRef = useRef<HTMLInputElement>(null);

  const isImageContentType = (type: string) =>
    ['image/png', 'image/webp', 'image/jpeg'].includes(type);

  const processAndUploadImage = async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    const image: UploadedImage = {
      id: self.crypto.randomUUID(),
      file,
      previewUrl,
    };

    setUploadingImages((prev) => [...prev, image]);

    try {
      const result = await getUploadUrl({
        workerId,
        contentType: file.type,
      });
      if (!result?.data || result?.validationErrors) {
        throw new Error('Failed to get upload URL');
      }

      const { url, key } = result.data;

      await fetch(url, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type,
        },
      });

      image.key = key;
      setUploadingImages((prev) => [...prev]);
    } catch (error) {
      console.error('Image upload failed:', error);
      toast.error(`Failed to upload image: ${file.name}`);
    }
  };

  const processAndUploadFile = async (file: File) => {
    const uploadedFile: UploadedFile = {
      id: self.crypto.randomUUID(),
      file,
      fileName: file.name,
      isImage: false,
    };

    setUploadingFiles((prev) => [...prev, uploadedFile]);

    try {
      const result = await getUploadUrl({
        workerId,
        contentType: file.type || 'application/octet-stream',
        fileName: file.name,
      });
      if (!result?.data || result?.validationErrors) {
        throw new Error('Failed to get upload URL');
      }

      const { url, key } = result.data;

      await fetch(url, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
      });

      uploadedFile.key = key;
      setUploadingFiles((prev) => [...prev]);
    } catch (error) {
      console.error('File upload failed:', error);
      toast.error(`Failed to upload file: ${file.name}`);
    }
  };

  const handleImageChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      await processAndUploadImage(files[i]);
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (isImageContentType(file.type)) {
        await processAndUploadImage(file);
      } else {
        await processAndUploadFile(file);
      }
    }

    if (generalFileInputRef.current) generalFileInputRef.current.value = '';
  };

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (onPasteOverride) {
      onPasteOverride(e);
      return;
    }

    const clipboardData = e.clipboardData;
    const items = clipboardData.items;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Check if the pasted content is an image
      if (item.type.indexOf('image') !== -1) {
        // Don't prevent default when pasting text
        e.preventDefault();

        const file = item.getAsFile();
        if (file) {
          await processAndUploadImage(file);
        }
      }
    }
  };

  useEffect(() => {
    const imageKeys = uploadingImages.map((i) => i.key).filter((k): k is string => k !== undefined);
    onImagesChange(imageKeys);
  }, [uploadingImages, onImagesChange]);

  useEffect(() => {
    const fileKeys = uploadingFiles.map((f) => f.key).filter((k): k is string => k !== undefined);
    onFilesChange?.(fileKeys);
  }, [uploadingFiles, onFilesChange]);

  const removeImage = (imageId: string) => {
    const removedImage = uploadingImages.find((image) => image.id === imageId);
    if (!removedImage) return;

    if (removedImage.previewUrl) {
      URL.revokeObjectURL(removedImage.previewUrl);
    }

    setUploadingImages((prev) => prev.filter((image) => image.id !== imageId));
  };

  const removeFile = (fileId: string) => {
    setUploadingFiles((prev) => prev.filter((file) => file.id !== fileId));
  };

  const handleImageSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelect = () => {
    generalFileInputRef.current?.click();
  };

  const clearImages = () => {
    uploadingImages.forEach((image) => {
      if (image.previewUrl) {
        URL.revokeObjectURL(image.previewUrl);
      }
    });
    setUploadingImages([]);
    setUploadingFiles([]);
  };

  const isUploading = uploadingImages.some((img) => !img.key) || uploadingFiles.some((f) => !f.key);

  return {
    uploadingImages,
    uploadingFiles,
    fileInputRef,
    handleImageSelect,
    handleFileSelect,
    handleImageChange,
    handleFileChange,
    handlePaste,
    removeImage,
    removeFile,
    clearImages,
    isUploading,
    ImagePreviewList: () => (
      <>
        {(uploadingImages.length > 0 || uploadingFiles.length > 0) && (
          <div className="flex flex-wrap gap-2 mb-2">
            {uploadingImages.map((image) => (
              <div key={image.id} className="relative">
                <Image
                  src={image.previewUrl}
                  alt="Upload preview"
                  width={80}
                  height={80}
                  className="h-20 w-20 object-cover rounded-md border border-gray-300"
                />
                {!image.key && (
                  <div className="absolute inset-0 bg-black bg-opacity-40 flex items-center justify-center rounded-md">
                    <Loader2 className="w-6 h-6 animate-spin text-white" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  className="absolute -top-2 -right-2 bg-gray-800 text-white rounded-full p-1"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {uploadingFiles.map((file) => (
              <div key={file.id} className="relative">
                <div className="h-20 px-3 flex items-center gap-2 rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800">
                  <FileDown className="w-5 h-5 text-gray-500 flex-shrink-0" />
                  <span className="text-xs text-gray-700 dark:text-gray-300 truncate max-w-[120px]">{file.fileName}</span>
                  {!file.key && (
                    <Loader2 className="w-4 h-4 animate-spin text-gray-400 flex-shrink-0" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(file.id)}
                  className="absolute -top-2 -right-2 bg-gray-800 text-white rounded-full p-1"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImageChange}
          accept="image/*"
          multiple
          className="hidden"
        />
        <input
          type="file"
          ref={generalFileInputRef}
          onChange={handleFileChange}
          multiple
          className="hidden"
        />
      </>
    ),
  };
}
