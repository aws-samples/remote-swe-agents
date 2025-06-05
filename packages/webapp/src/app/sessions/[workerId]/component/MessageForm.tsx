'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { Loader2, Send, Image as ImageIcon, X } from 'lucide-react';
import { toast } from 'sonner';
import { sendMessageToAgent } from '../actions';
import { sendMessageToAgentSchema } from '../schemas';
import { KeyboardEventHandler, useState, useRef, ChangeEvent } from 'react';
import { Message } from './MessageList';
import { useTranslations } from 'next-intl';
import { getUploadUrl } from '@/lib/actions/s3';

type MessageFormProps = {
  onSubmit: (message: Message) => void;
  workerId: string;
};

type UploadingImage = {
  file: File;
  previewUrl: string;
  key?: string;
  uploading: boolean;
};

export default function MessageForm({ onSubmit, workerId }: MessageFormProps) {
  const t = useTranslations('sessions');
  const [uploadingImages, setUploadingImages] = useState<UploadingImage[]>([]);
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
        // 送信後に画像をクリア
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

  const handleImageChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newImages: UploadingImage[] = [];
    const imageKeys: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const previewUrl = URL.createObjectURL(file);

      newImages.push({
        file,
        previewUrl,
        uploading: true,
      });

      try {
        // S3への署名付きURLを取得
        const result = await getUploadUrl({
          fileName: file.name,
          contentType: file.type,
        });

        if (result && !result.validationErrors && result.data) {
          const { url, key } = result.data;

          if (url && key) {
            // S3に直接アップロード
            await fetch(url, {
              method: 'PUT',
              body: file,
              headers: {
                'Content-Type': file.type,
              },
            });

            // 成功したらキーを保存
            imageKeys.push(key);

            // アップロード完了状態を更新
            setUploadingImages((prev) =>
              prev.map((img, idx) => (idx === i + uploadingImages.length ? { ...img, key, uploading: false } : img))
            );
          }
        }
      } catch (error) {
        console.error('Image upload failed:', error);
        toast.error(`Failed to upload image: ${file.name}`);
      }
    }

    // すでにあるimageKeysと新しいものを結合
    const existingKeys = watch('imageKeys') || [];
    setValue('imageKeys', [...existingKeys, ...imageKeys]);

    setUploadingImages((prev) => [...prev, ...newImages]);

    // ファイル選択をリセット
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    const removedImage = uploadingImages[index];

    // プレビューURLの解放
    if (removedImage.previewUrl) {
      URL.revokeObjectURL(removedImage.previewUrl);
    }

    // アップロード済みの場合は、imageKeysからも削除
    if (removedImage.key) {
      const currentKeys = watch('imageKeys') || [];
      const filteredKeys = currentKeys.filter((key) => key !== removedImage.key);
      setValue('imageKeys', filteredKeys);
    }

    // 画像リストから削除
    setUploadingImages(uploadingImages.filter((_, i) => i !== index));
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="max-w-4xl mx-auto px-4 py-4">
        <form onSubmit={handleSubmitWithAction} className="flex flex-col gap-4">
          {uploadingImages.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {uploadingImages.map((img, index) => (
                <div key={index} className="relative">
                  <img
                    src={img.previewUrl}
                    alt="Upload preview"
                    className="h-20 w-20 object-cover rounded-md border border-gray-300"
                  />
                  {img.uploading && (
                    <div className="absolute inset-0 bg-black bg-opacity-40 flex items-center justify-center rounded-md">
                      <Loader2 className="w-6 h-6 animate-spin text-white" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeImage(index)}
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
              <Button
                type="submit"
                disabled={
                  (!message.trim() && uploadingImages.length === 0) ||
                  isExecuting ||
                  uploadingImages.some((img) => img.uploading)
                }
                size="icon"
              >
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
