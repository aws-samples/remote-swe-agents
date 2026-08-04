'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface HandoverModalProps {
  isOpen: boolean;
  isExecuting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default function HandoverModal({ isOpen, isExecuting, onClose, onConfirm }: HandoverModalProps) {
  const t = useTranslations('sessions');

  if (!isOpen) return null;

  const handleClose = () => {
    if (isExecuting) return;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full border border-gray-200 dark:border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('handoverSession')}</h2>
          <button
            onClick={handleClose}
            disabled={isExecuting}
            className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 cursor-pointer p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            ✕
          </button>
        </div>
        <div className="p-4">
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">{t('handoverSessionDescription')}</p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={isExecuting}
              className="flex-1 px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 dark:text-gray-200 dark:bg-gray-700 dark:border-gray-600 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {t('cancel')}
            </button>
            <button
              onClick={onConfirm}
              disabled={isExecuting}
              className="flex-1 px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {isExecuting && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('handoverConfirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
