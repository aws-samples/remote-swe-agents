'use client';

import React, { useState, useEffect, useMemo } from 'react';
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

export const ImageViewer = ({ imageKeys: inputKeys }: ImageViewerProps) => {
  const [images, setImages] = useState<ImageData[]>([]);
  const [imageCache, setImageCache] = useState<Map<string, ImageData>>(new Map());
  const imageKeys = useMemo(
    () =>
      inputKeys.filter(
        (key) =>
          key.endsWith('.jpg') ||
          key.endsWith('.jpeg') ||
          key.endsWith('.png') ||
          key.endsWith('.webp') ||
          key.endsWith('.svg') ||
          false
      ),
    [inputKeys]
  );

  useEffect(() => {
    const loadImages = async () => {
      // Build display data immediately from existing cache (without showing loading state)
      const currentImages = imageKeys.map((key) => {
        const cached = imageCache.get(key);
        return cached ?? { key, url: '', loading: true, error: false };
      });
      setImages(currentImages);

      // Always refetch signed URLs as they may expire
      try {
        const result = await getImageUrls({ keys: imageKeys });

        if (result?.data) {
          // Update cache
          const newCache = new Map(imageCache);
          result.data.forEach((item) => {
            newCache.set(item.key, {
              key: item.key,
              url: item.url,
              loading: false,
              error: false,
            });
          });
          setImageCache(newCache);

          // Update display data from cache
          setImages(
            imageKeys.map((key) => {
              const cached = newCache.get(key);
              return cached || { key, url: '', loading: false, error: true };
            })
          );
        }
      } catch (error) {
        console.error('Failed to load image URLs:', error);
        // On error, preserve existing cache and only set new keys to error state
        const newCache = new Map(imageCache);
        imageKeys.forEach((key) => {
          if (!newCache.has(key)) {
            newCache.set(key, { key, url: '', loading: false, error: true });
          }
        });
        setImageCache(newCache);

        setImages(
          imageKeys.map((key) => {
            const cached = newCache.get(key);
            return cached || { key, url: '', loading: false, error: true };
          })
        );
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
