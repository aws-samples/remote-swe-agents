'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Loader2, ExternalLink, X } from 'lucide-react';
import { getImageUrls } from '@/actions/image/action';
import { claimForMessage, isUsable, releaseFromMessage, scheduleReleaseFromMessage } from '@/lib/local-image-urls';
import { useBodyScrollLock } from '@/hooks/use-body-scroll-lock';

type ImageViewerProps = {
  imageKeys: string[];
  /**
   * Blob object URLs for keys whose bytes are already in local memory (the
   * submitter's own optimistic bubble, see `MessageView.localImageUrls`).
   * Seeded into the cache so the image paints instantly; the real pre-signed
   * URL is fetched in the background and swapped in only after it has fully
   * loaded (no flicker), at which point the blob is revoked.
   */
  localImageUrls?: Record<string, string>;
};

type ImageData = {
  key: string;
  url: string;
  loading: boolean;
  error: boolean;
};

/**
 * Preload the pre-signed URL fully before swapping it into the <img>, so the
 * blob → https transition never flashes.
 */
const preloadImage = (url: string) =>
  new Promise<void>((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to preload ${url}`));
    img.src = url;
  });

export const ImageViewer = ({ imageKeys: inputKeys, localImageUrls }: ImageViewerProps) => {
  // Lazy initializer: seed once per mount from the blob previews.
  // `localImageUrls` is set at optimistic-submit time and never changes for
  // a given message; URLs already revoked (per the ownership registry) are
  // skipped so a remount falls back to the normal spinner → pre-signed path.
  const [seededEntries] = useState<ImageData[]>(() => {
    if (!localImageUrls) return [];
    return Object.entries(localImageUrls)
      .filter(([, url]) => isUsable(url))
      .map(([key, url]) => ({ key, url, loading: false, error: false }));
  });
  const [images, setImages] = useState<ImageData[]>([]);
  const [imageCache, setImageCache] = useState<Map<string, ImageData>>(
    () => new Map(seededEntries.map((entry) => [entry.key, entry]))
  );

  // Blob lifecycle (see lib/local-image-urls.ts): claim ownership for this
  // message on mount; on unmount, schedule a token-guarded deferred release
  // for whatever was not already released by a successful swap. A remount of
  // the same message (pending → confirmed id change, StrictMode) re-claims
  // within the grace window and keeps the blob alive; a rollback moves
  // ownership to the uploader, making the release a no-op; a permanent
  // unmount lets the release revoke the blob so it cannot leak until the
  // tab closes.
  useEffect(() => {
    const urls = seededEntries.map((entry) => entry.url);
    urls.forEach(claimForMessage);
    return () => {
      urls.forEach((url) => scheduleReleaseFromMessage(url));
    };
  }, [seededEntries]);
  const [previewImage, setPreviewImage] = useState<ImageData | null>(null);
  const imageKeys = useMemo(
    () =>
      inputKeys.filter(
        (key) =>
          key.endsWith('.jpg') ||
          key.endsWith('.jpeg') ||
          key.endsWith('.png') ||
          key.endsWith('.webp') ||
          key.endsWith('.svg') ||
          key.endsWith('.gif') ||
          false
      ),
    [inputKeys]
  );

  useEffect(() => {
    // Cancellation guard (W1): the async pipeline below (getImageUrls →
    // preload → swap/release) can outlive this effect — the bubble may be
    // rolled back (unmount) or the message id may change (remount) while a
    // request is in flight. A cancelled pipeline must neither touch state
    // nor release a blob it may no longer own.
    let cancelled = false;
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
        if (cancelled) return;

        if (result?.data) {
          // Keys currently painted from a local blob preview swap lazily:
          // the pre-signed URL is preloaded first so the <img> never flashes
          // during the src change, then the blob is revoked. Everything else
          // updates immediately (existing behaviour).
          const isBlobBacked = (key: string) => imageCache.get(key)?.url.startsWith('blob:') ?? false;
          const immediate = result.data.filter((item) => !isBlobBacked(item.key));
          const deferred = result.data.filter((item) => isBlobBacked(item.key));

          // Update cache
          const newCache = new Map(imageCache);
          immediate.forEach((item) => {
            newCache.set(item.key, {
              key: item.key,
              url: item.url,
              loading: false,
              error: false,
            });
          });
          setImageCache(newCache);

          // Update display data from cache (blob-backed keys keep their
          // seeded blob entry here; they are swapped below once preloaded)
          setImages(
            imageKeys.map((key) => {
              const cached = newCache.get(key);
              return cached || { key, url: '', loading: false, error: true };
            })
          );

          deferred.forEach(({ key, url }) => {
            const blobUrl = imageCache.get(key)!.url;
            void preloadImage(url)
              .then(() => {
                // Cancelled (rollback / remount): do not touch state, and do
                // NOT release the blob — ownership may have moved back to
                // the uploader, or a remounted viewer may still be
                // displaying it. The unmount cleanup's deferred release (or
                // the new owner) handles the blob's fate.
                if (cancelled) return;
                const entry: ImageData = { key, url, loading: false, error: false };
                setImageCache((prev) => new Map(prev).set(key, entry));
                setImages((prev) => prev.map((img) => (img.key === key ? entry : img)));
                // Swap complete: revoke IF this message still owns the blob
                // (no-op if a rollback returned it to the uploader first).
                releaseFromMessage(blobUrl);
              })
              .catch(() => {
                // Preload failed (network hiccup / expired URL): keep
                // showing the blob. Nothing is persisted, so a reload
                // resolves the image through the normal pre-signed path;
                // the unmount cleanup's deferred release prevents a leak.
              });
          });
        }
      } catch (error) {
        if (cancelled) return;
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
    return () => {
      cancelled = true;
    };
    // `imageCache` is a mutable Map used as a cross-render cache; it is
    // intentionally not a dependency (re-running on cache mutation would
    // defeat the cache and re-fetch every image).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKeys]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && previewImage) {
        e.stopPropagation();
        setPreviewImage(null);
      }
    },
    [previewImage]
  );

  useEffect(() => {
    if (previewImage) {
      document.addEventListener('keydown', handleKeyDown, true);
      return () => {
        document.removeEventListener('keydown', handleKeyDown, true);
      };
    }
  }, [previewImage, handleKeyDown]);

  useBodyScrollLock(!!previewImage);

  if (imageKeys.length === 0) {
    return null;
  }

  return (
    <>
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
                <button onClick={() => setPreviewImage(image)} className="block">
                  {/* eslint-disable-next-line @next/next/no-img-element -- src is a
                      dynamic pre-signed S3 / blob URL; next/image's loader and
                      domain allow-list do not apply. */}
                  <img
                    src={image.url}
                    alt={`Image ${image.key}`}
                    className="w-32 h-24 object-cover rounded cursor-pointer hover:opacity-80 transition-opacity"
                  />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {previewImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm overscroll-contain touch-pinch-zoom"
          onClick={() => setPreviewImage(null)}
        >
          <div className="absolute top-4 right-4 flex gap-2 z-10">
            <a
              href={previewImage.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              title="Open in new tab"
            >
              <ExternalLink className="w-5 h-5" />
            </a>
            <button
              onClick={() => setPreviewImage(null)}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- dynamic
              pre-signed S3 / blob URL, see above. */}
          <img
            src={previewImage.url}
            alt={`Preview ${previewImage.key}`}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
};
