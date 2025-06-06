'use client';

import { useState, useRef, ChangeEvent, useEffect, ClipboardEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { getUploadUrl } from '@/actions/upload/action';
import Image from 'next/image';

export type UploadedImage = {
  id: string;
  file: File;
  previewUrl: string;
  key?: string; // undefined means it is being uploaded
};

type ImageUploaderProps = {
  workerId?: string;
  onImagesChange: (imageKeys: string[]) => void;
  onPasteOverride?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
};

export default function ImageUploader({ workerId, onImagesChange, onPasteOverride }: ImageUploaderProps) {
  const [uploadingImages, setUploadingImages] = useState<UploadedImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleImageChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      await processAndUploadImage(files[i]);
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
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

  const removeImage = (imageId: string) => {
    const removedImage = uploadingImages.find((image) => image.id === imageId);
    if (!removedImage) return;

    if (removedImage.previewUrl) {
      URL.revokeObjectURL(removedImage.previewUrl);
    }

    setUploadingImages((prev) => prev.filter((image) => image.id !== imageId));
  };

  const handleImageSelect = () => {
    fileInputRef.current?.click();
  };

  return {
    uploadingImages,
    fileInputRef,
    handleImageSelect,
    handleImageChange,
    handlePaste,
    removeImage,
    ImagePreviewList: () => (
      <>
        {uploadingImages.length > 0 && (
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
      </>
    ),
  };
}
