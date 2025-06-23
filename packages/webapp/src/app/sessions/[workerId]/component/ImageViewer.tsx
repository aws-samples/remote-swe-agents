'use client';

import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { getImageUrls } from '@/actions/image/action';

type ImageViewerProps = {
  imageKeys: string[];
};

type ImageData = {
  key: string;
  url: string;
  loading: boolean;
  error: boolean;
};

export const ImageViewer = ({ imageKeys }: ImageViewerProps) => {
  const [images, setImages] = useState<ImageData[]>([]);

  useEffect(() => {
    const loadImages = async () => {
      setImages(imageKeys.map((key) => ({ key, url: '', loading: true, error: false })));

      try {
        const result = await getImageUrls({ keys: imageKeys });

        if (result?.data) {
          setImages(
            result.data.map((item) => ({
              key: item.key,
              url: item.url,
              loading: false,
              error: false,
            }))
          );
        }
      } catch (error) {
        console.error('Failed to load image URLs:', error);
        setImages((prev) => prev.map((img) => ({ ...img, loading: false, error: true })));
      }
    };

    if (imageKeys.length > 0) {
      loadImages();
    }
  }, [imageKeys]);

  if (imageKeys.length === 0) {
    return null;
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-2">
        {images.map((image) => (
          <div key={image.key}>
            {image.loading ? (
              <div className="w-32 h-24 bg-gray-100 dark:bg-gray-800 rounded flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : image.error ? (
              <div className="w-32 h-24 bg-gray-100 dark:bg-gray-800 rounded flex items-center justify-center">
                <span className="text-xs text-gray-500">Error</span>
              </div>
            ) : (
              <a href={image.url} target="_blank" rel="noopener noreferrer">
                <img
                  src={image.url}
                  alt={`Image ${image.key}`}
                  className="w-32 h-24 object-cover rounded cursor-pointer hover:opacity-80 transition-opacity"
                />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
