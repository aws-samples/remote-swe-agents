'use client';

import { useState, useRef, ChangeEvent, useEffect, useCallback, ClipboardEvent } from 'react';
import { Loader2, X, FileDown, ImageOff } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { getUploadUrl } from '@/actions/upload/action';
import { getImageUrls } from '@/actions/image/action';
import { claimForMessage, markRevoked, returnToUploader } from '@/lib/local-image-urls';
import Image from 'next/image';

export type UploadedImage = {
  id: string;
  file?: File;
  previewUrl: string;
  key?: string; // undefined means it is being uploaded
};

export type UploadedFile = {
  id: string;
  file?: File;
  fileName: string;
  key?: string; // undefined means it is being uploaded
  isImage: boolean;
};

/**
 * Attachments whose ownership was transferred out of the uploader at submit
 * time (see `takeoverAttachments`). Image `previewUrl`s are live blob object
 * URLs — whoever holds this object is responsible for their eventual
 * revocation (or for handing them back via `restoreTakenOverAttachments`).
 */
export type TakenOverAttachments = {
  images: { key: string; previewUrl: string }[];
  files: { key: string; fileName: string }[];
};

type UseImageUploaderArgs = {
  workerId?: string;
  onImagesChange: (imageKeys: string[]) => void;
  onFilesChange?: (fileKeys: string[]) => void;
  onPasteOverride?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
};

const isImageContentType = (type: string) => ['image/png', 'image/webp', 'image/jpeg'].includes(type);

/**
 * Custom hook for handling file/image attachments backed by S3 pre-signed PUT.
 *
 * Returns a tuple-like object that combines the state, the imperative handlers
 * the form needs (`handleFileSelect`, `handlePaste`, `clearImages`), and a
 * pre-bound `ImagePreviewList` component that renders the previews + the two
 * hidden `<input type="file">` elements that drive the picker.
 *
 * Naming note: `useImageUploader` rather than `ImageUploader` because the
 * function uses `useState` / `useRef` / `useEffect` / `useCallback` and is
 * therefore a hook. Calling it `ImageUploader` made eslint-plugin-react-hooks
 * skip its checks (which masked subtle bugs in earlier revisions).
 */
export function useImageUploader({ workerId, onImagesChange, onFilesChange, onPasteOverride }: UseImageUploaderArgs) {
  const t = useTranslations('sessions');
  const [uploadingImages, setUploadingImages] = useState<UploadedImage[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<UploadedFile[]>([]);
  const generalFileInputRef = useRef<HTMLInputElement>(null);

  // The parent passes fresh `onImagesChange` / `onFilesChange` callbacks on
  // every render. Stash them in refs so the effects that fan changes back to
  // the form don't have to re-run on every parent render — they should only
  // re-run when the underlying upload list actually changes.
  const onImagesChangeRef = useRef(onImagesChange);
  const onFilesChangeRef = useRef(onFilesChange);
  useEffect(() => {
    onImagesChangeRef.current = onImagesChange;
  }, [onImagesChange]);
  useEffect(() => {
    onFilesChangeRef.current = onFilesChange;
  }, [onFilesChange]);

  const processAndUploadImage = useCallback(
    async (file: File) => {
      const id = self.crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      const image: UploadedImage = { id, file, previewUrl };

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

        // Immutable update: produce a new entry with `key` set rather than
        // mutating the existing object reference. The previous in-place
        // mutation worked, but only because the surrounding `[...prev]` made
        // React see a new array — relying on that is fragile under
        // concurrent rendering and StrictMode double-invocation.
        setUploadingImages((prev) => prev.map((entry) => (entry.id === id ? { ...entry, key } : entry)));
      } catch (error) {
        console.error('Image upload failed:', error);
        toast.error(`Failed to upload image: ${file.name}`);
        // Remove the failed entry so the spinner clears and `isUploading`
        // can flip back to false. Without this, a single failed upload
        // pinned the submit button in its disabled state forever (until
        // the user removed every other attachment too).
        URL.revokeObjectURL(previewUrl);
        markRevoked(previewUrl);
        setUploadingImages((prev) => prev.filter((entry) => entry.id !== id));
      }
    },
    [workerId]
  );

  const processAndUploadFile = useCallback(
    async (file: File) => {
      const id = self.crypto.randomUUID();
      const uploadedFile: UploadedFile = {
        id,
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

        setUploadingFiles((prev) => prev.map((entry) => (entry.id === id ? { ...entry, key } : entry)));
      } catch (error) {
        console.error('File upload failed:', error);
        toast.error(`Failed to upload file: ${file.name}`);
        // Same reasoning as in `processAndUploadImage`: drop the failed
        // entry so `isUploading` can flip back to false.
        setUploadingFiles((prev) => prev.filter((entry) => entry.id !== id));
      }
    },
    [workerId]
  );

  const handleFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
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

      // Reset the input value so picking the same file twice in a row still
      // fires `change` the second time.
      if (generalFileInputRef.current) generalFileInputRef.current.value = '';
    },
    [processAndUploadImage, processAndUploadFile]
  );

  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
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
    },
    [onPasteOverride, processAndUploadImage]
  );

  // Fan upload state changes back to the form. We deliberately depend only on
  // the upload list (not on the callback) so this effect is tied to "upload
  // list changed" rather than "parent re-rendered".
  useEffect(() => {
    const imageKeys = uploadingImages.map((i) => i.key).filter((k): k is string => k !== undefined);
    onImagesChangeRef.current(imageKeys);
  }, [uploadingImages]);

  useEffect(() => {
    const fileKeys = uploadingFiles.map((f) => f.key).filter((k): k is string => k !== undefined);
    onFilesChangeRef.current?.(fileKeys);
  }, [uploadingFiles]);

  const removeImage = useCallback((imageId: string) => {
    setUploadingImages((prev) => {
      const removed = prev.find((image) => image.id === imageId);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
        markRevoked(removed.previewUrl);
      }
      return prev.filter((image) => image.id !== imageId);
    });
  }, []);

  const removeFile = useCallback((fileId: string) => {
    setUploadingFiles((prev) => prev.filter((file) => file.id !== fileId));
  }, []);

  const handleFileSelect = useCallback(() => {
    generalFileInputRef.current?.click();
  }, []);

  const clearImages = useCallback(() => {
    setUploadingImages((prev) => {
      prev.forEach((image) => {
        if (image.previewUrl) {
          URL.revokeObjectURL(image.previewUrl);
          markRevoked(image.previewUrl);
        }
      });
      return [];
    });
    setUploadingFiles([]);
  }, []);

  /**
   * Restore attachment previews from S3 object keys of a previous submission
   * attempt (the objects were already uploaded via pre-signed PUT, so only
   * the keys are needed). Used by the stale-deployment recovery path and the
   * draft-attachments restore. Every key (images and files alike) is
   * verified against S3 via `getImageUrls` (HeadObject + pre-signed GET);
   * keys that no longer exist are surfaced to the user with a toast instead
   * of silently vanishing.
   *
   * Returns the subset of keys that actually exist in S3 so callers can
   * rewrite their persisted entry to match (preventing a stale entry from
   * re-toasting "could not be restored" on every subsequent reload), or
   * `null` when the lookup itself failed (network etc.) — in that case the
   * caller should keep its entry and retry on the next mount.
   * Image previews use short-lived pre-signed GET URLs; revoking them later
   * via URL.revokeObjectURL is a harmless no-op.
   */
  const restoreFromKeys = useCallback(
    async (imageKeys: string[], fileKeys: string[]): Promise<{ imageKeys: string[]; fileKeys: string[] } | null> => {
      if (imageKeys.length === 0 && fileKeys.length === 0) return { imageKeys: [], fileKeys: [] };
      try {
        const result = await getImageUrls({ keys: [...imageKeys, ...fileKeys] });
        if (!result?.data) {
          throw new Error('Failed to look up attachments');
        }
        const found = new Map(result.data.map(({ key, url }) => [key, url]));
        const missingCount = [...imageKeys, ...fileKeys].filter((key) => !found.has(key)).length;
        if (missingCount > 0) {
          toast.error(t('attachmentsPartiallyRestored'));
        }
        const restorableFileKeys = fileKeys.filter((key) => found.has(key));
        if (restorableFileKeys.length > 0) {
          setUploadingFiles((prev) => {
            const known = new Set(prev.map((f) => f.key));
            return [
              ...prev,
              ...restorableFileKeys
                .filter((key) => !known.has(key))
                .map((key) => ({
                  id: self.crypto.randomUUID(),
                  fileName: key.split('/').pop() || 'file',
                  key,
                  isImage: false,
                })),
            ];
          });
        }
        const restorableImageKeys = imageKeys.filter((key) => found.has(key));
        if (restorableImageKeys.length > 0) {
          setUploadingImages((prev) => {
            const known = new Set(prev.map((i) => i.key));
            return [
              ...prev,
              ...restorableImageKeys
                .filter((key) => !known.has(key))
                .map((key) => ({ id: self.crypto.randomUUID(), previewUrl: found.get(key)!, key })),
            ];
          });
        }
        return { imageKeys: restorableImageKeys, fileKeys: restorableFileKeys };
      } catch (error) {
        console.error('Failed to restore attachments:', error);
        toast.error('Failed to restore attachments');
        return null;
      }
    },
    [t]
  );

  /**
   * Re-enter images into the uploader by S3 key alone, with NO preview URL
   * (rendered as a placeholder thumbnail). Last line of defence for the
   * rollback path when a taken-over blob was already revoked AND the
   * pre-signed lookup (`restoreFromKeys`) itself failed: the key must still
   * survive in uploader state — and therefore in the form values and the
   * persisted draft, both derived from it via the fan-out effect — so a
   * resend still attaches the image. See lib/rollback-attachments.ts.
   */
  const restoreKeyOnlyImages = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    const entries = keys.map((key) => ({ id: self.crypto.randomUUID(), previewUrl: '', key }));
    setUploadingImages((prev) => {
      const known = new Set(prev.map((i) => i.key));
      return [...prev, ...entries.filter((e) => !known.has(e.key))];
    });
  }, []);

  const isUploading = uploadingImages.some((img) => !img.key) || uploadingFiles.some((f) => !f.key);

  /**
   * Hand the completed attachments over to the caller (the optimistic
   * message bubble) and remove them from the uploader's preview strip.
   *
   * Ownership transfer semantics: the returned blob `previewUrl`s are NOT
   * revoked here — the receiver (the optimistic bubble's `ImageViewer`)
   * becomes responsible for revoking each blob once it has swapped in the
   * real pre-signed URL. This is what lets the just-sent image render
   * instantly in the chat without waiting for any network round trip,
   * while also preventing the double-display of the same image in both the
   * form preview strip and the chat bubble.
   *
   * Only entries whose upload completed (`key` set) are taken over; the
   * submit button is disabled while `isUploading`, so in practice that is
   * all of them.
   */
  const takeoverAttachments = useCallback((): TakenOverAttachments => {
    const images = uploadingImages
      .filter((i): i is UploadedImage & { key: string } => i.key !== undefined)
      .map((i) => ({ key: i.key, previewUrl: i.previewUrl }));
    const files = uploadingFiles
      .filter((f): f is UploadedFile & { key: string } => f.key !== undefined)
      .map((f) => ({ key: f.key, fileName: f.fileName }));
    // Key-only entries (previewUrl === '') carry no blob to claim; their
    // keys still transfer so a resend includes them.
    images.forEach((i) => i.previewUrl && claimForMessage(i.previewUrl));
    setUploadingImages((prev) => prev.filter((i) => i.key === undefined));
    setUploadingFiles((prev) => prev.filter((f) => f.key === undefined));
    return { images, files };
  }, [uploadingImages, uploadingFiles]);

  /**
   * Put attachments taken over by `takeoverAttachments` back into the
   * uploader (submission failed and the optimistic bubble was rolled
   * back). Blob preview URLs are reused as-is — no network round trip —
   * and blob ownership returns to the uploader (revoked on remove/clear
   * as usual). Ids are generated OUTSIDE the state updater so StrictMode
   * double-invocation cannot mint divergent ids.
   */
  const restoreTakenOverAttachments = useCallback((attachments: TakenOverAttachments) => {
    if (attachments.images.length > 0) {
      const entries = attachments.images.map((i) => ({
        id: self.crypto.randomUUID(),
        previewUrl: i.previewUrl,
        key: i.key,
      }));
      entries.forEach((e) => returnToUploader(e.previewUrl));
      setUploadingImages((prev) => {
        const known = new Set(prev.map((i) => i.key));
        return [...prev, ...entries.filter((e) => !known.has(e.key))];
      });
    }
    if (attachments.files.length > 0) {
      const entries = attachments.files.map((f) => ({
        id: self.crypto.randomUUID(),
        fileName: f.fileName,
        key: f.key,
        isImage: false,
      }));
      setUploadingFiles((prev) => {
        const known = new Set(prev.map((f) => f.key));
        return [...prev, ...entries.filter((e) => !known.has(e.key))];
      });
    }
  }, []);

  const ImagePreviewList = useCallback(
    () => (
      <>
        {(uploadingImages.length > 0 || uploadingFiles.length > 0) && (
          <div className="flex flex-wrap gap-2 mb-2">
            {uploadingImages.map((image) => (
              <div key={image.id} className="relative">
                {image.previewUrl ? (
                  <Image
                    src={image.previewUrl}
                    alt="Upload preview"
                    width={80}
                    height={80}
                    className="h-20 w-20 object-cover rounded-md border border-gray-300"
                    // Previews use two URL schemes: fresh uploads are blob:
                    // object URLs (served as-is by next/image), while restored
                    // attachments are pre-signed S3 https URLs. The latter
                    // would be routed through /_next/image, which rejects them
                    // with 400 because the bucket host is not configured in
                    // images.remotePatterns (and chat images elsewhere use
                    // plain <img> for the same reason, see ImageViewer).
                    // `unoptimized` makes both schemes load directly — an
                    // 80px ephemeral thumbnail gains nothing from the
                    // optimizer anyway.
                    unoptimized
                  />
                ) : (
                  // Key-only entry (restoreKeyOnlyImages): the blob preview
                  // was revoked and the pre-signed lookup failed, but the S3
                  // key survives — the image still attaches on resend.
                  <div className="h-20 w-20 flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800">
                    <ImageOff className="w-6 h-6 text-gray-400" />
                  </div>
                )}
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
                  <span className="text-xs text-gray-700 dark:text-gray-300 truncate max-w-[120px]">
                    {file.fileName}
                  </span>
                  {!file.key && <Loader2 className="w-4 h-4 animate-spin text-gray-400 flex-shrink-0" />}
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
        {/*
         * iOS Safari fires the `change` event unreliably on `<input type="file">`
         * elements that are styled with `display: none` (Tailwind's `hidden`):
         * the native picker opens and the user picks a file, but the input is
         * treated as not-rendered when the picker returns, so `change` never
         * dispatches and `handleFileChange` is never invoked. The bug is
         * intermittent (depends on Safari's render pipeline and process state
         * when the picker comes back) which is why it manifests as a "the
         * file dialog opened, I picked something, but nothing happened"
         * symptom that no toast and no console error accompany.
         *
         * Tailwind's `sr-only` (visually-hidden) keeps the element in layout
         * with non-zero size, which is enough for WebKit to dispatch
         * `change` reliably. The element remains invisible and cannot
         * receive pointer events because it's clipped, so no UX changes for
         * sighted users. Programmatic `.click()` from the Paperclip button
         * still works exactly as before.
         */}
        <input type="file" ref={generalFileInputRef} onChange={handleFileChange} multiple className="sr-only" />
      </>
    ),
    [uploadingImages, uploadingFiles, removeImage, removeFile, handleFileChange]
  );

  return {
    uploadingImages,
    uploadingFiles,
    handleFileSelect,
    handlePaste,
    clearImages,
    restoreFromKeys,
    restoreKeyOnlyImages,
    takeoverAttachments,
    restoreTakenOverAttachments,
    isUploading,
    ImagePreviewList,
  };
}

/**
 * Backwards-compatible default export. New call-sites should use the named
 * `useImageUploader` hook directly so eslint-plugin-react-hooks recognises it.
 *
 * @deprecated Use `useImageUploader` instead.
 */
export default useImageUploader;
