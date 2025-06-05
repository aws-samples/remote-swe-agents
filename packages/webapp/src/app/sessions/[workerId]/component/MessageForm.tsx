'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { Loader2, Send, Image as ImageIcon, X } from 'lucide-react';
import { toast } from 'sonner';
import { sendMessageToAgent } from '../actions';
import { sendMessageToAgentSchema } from '../schemas';
import { KeyboardEventHandler, useState, useRef, ChangeEvent, useEffect, ClipboardEvent } from 'react';
import { Message } from './MessageList';
import { useTranslations } from 'next-intl';
import { getUploadUrl } from '@/actions/upload/action';
import Image from 'next/image';

type MessageFormProps = {
  onSubmit: (message: Message) => void;
  workerId: string;
};

type UploadedImages = {
  id: string;
  file: File;
  previewUrl: string;
  key?: string; // undefined means it is being uploaded
};

export default function MessageForm({ onSubmit, workerId }: MessageFormProps) {
  const t = useTranslations('sessions');
  const [uploadingImages, setUploadingImages] = useState<UploadedImages[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    form: { register, formState, reset, watch, setValue },
    action: { isExecuting },
    handleSubmitWithAction,
  } = useHookFormAction(sendMessageToAgent, zodResolver(sendMessageToAgentSchema), {
    actionProps: {
      onSuccess: (args) => {
        if (args.data) {
          onSubmit({
            id: args.data.item.SK,
            role: 'user',
            content: args.input.message,
            timestamp: new Date(parseInt(args.data.item.SK)),
            type: 'message',
          });
        }
        reset();
        setUploadingImages([]);
      },
      onError: ({ error }) => {
        toast.error(typeof error === 'string' ? error : 'Failed to send the message');
      },
    },
    formProps: {
      defaultValues: {
        message: '',
        workerId: workerId,
        imageKeys: [],
      },
    },
  });

  const message = watch('message');

  const enterPost: KeyboardEventHandler = (keyEvent) => {
    if (isExecuting) return;
    if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.altKey)) {
      handleSubmitWithAction();
    }
  };

  const handleImageSelect = () => {
    fileInputRef.current?.click();
  };

  const processAndUploadImage = async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    const image: UploadedImages = {
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
    setValue(
      'imageKeys',
      uploadingImages.map((i) => i.key).filter((k) => k !== undefined)
    );
  }, [uploadingImages, setValue]);

  const removeImage = (imageId: string) => {
    const removedImage = uploadingImages.find((image) => image.id == imageId);
    if (!removedImage) return;

    if (removedImage.previewUrl) {
      URL.revokeObjectURL(removedImage.previewUrl);
    }

    setUploadingImages((prev) => prev.filter((image) => image.id !== imageId));
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="max-w-4xl mx-auto px-4 py-4">
        <form onSubmit={handleSubmitWithAction} className="flex flex-col gap-4">
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

          <div className="flex gap-4">
            <textarea
              {...register('message')}
              placeholder={t('enterYourMessage')}
              className="flex-1 resize-none border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              rows={3}
              disabled={isExecuting}
              onKeyDown={enterPost}
              onPaste={handlePaste}
            />
            <div className="flex flex-col gap-2 self-end">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleImageChange}
                accept="image/*"
                multiple
                className="hidden"
              />
              <Button type="button" onClick={handleImageSelect} disabled={isExecuting} size="icon" variant="outline">
                <ImageIcon className="w-4 h-4" />
              </Button>
              <Button type="submit" disabled={!message.trim() || isExecuting} size="icon">
                {isExecuting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          <input hidden {...register('workerId')} />
          <input hidden {...register('imageKeys')} />
        </form>
      </div>
    </div>
  );
}
