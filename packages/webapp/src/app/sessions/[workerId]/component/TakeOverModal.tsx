'use client';

import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

interface TakeOverModalProps {
  workerId: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function TakeOverModal({ workerId, isOpen, onClose }: TakeOverModalProps) {
  const t = useTranslations('sessions');

  if (!isOpen) return null;

  const getShareText = () => {
    const sessionUrl = `${window.location.origin}/sessions/${workerId}`;
    return `take_over ${sessionUrl}`;
  };

  const handleCopyToClipboard = async () => {
    await navigator.clipboard.writeText(getShareText());
    toast.success(t('copiedToClipboard'));
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          text: getShareText(),
        });
      } catch (error) {
        console.log('Error sharing:', error);
      }
    } else {
      await handleCopyToClipboard();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full border border-gray-200 dark:border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('shareSession')}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 cursor-pointer p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="p-4">
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{t('shareSessionDescription')}</p>
          <div className="bg-gray-50 dark:bg-gray-700 p-3 rounded-md mb-4 overflow-x-auto">
            <code className="text-sm text-gray-800 dark:text-gray-200 whitespace-nowrap">{getShareText()}</code>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCopyToClipboard}
              className="flex-1 px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 dark:text-gray-200 dark:bg-gray-700 dark:border-gray-600 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              {t('copyToClipboard')}
            </button>
            <button
              onClick={handleShare}
              className="flex-1 px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              {t('share')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
