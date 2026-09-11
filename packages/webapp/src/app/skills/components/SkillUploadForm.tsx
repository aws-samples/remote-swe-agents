'use client';

import { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Upload, FolderOpen } from 'lucide-react';
import { zipSync } from 'fflate';
import { getSkillUploadUrl, registerSkill, deleteSkill } from '@/actions/skill/action';
import { useRouter } from 'next/navigation';

type UploadState = 'idle' | 'uploading' | 'registering';

type Props = {
  existingSkillNames?: { name: string; SK: string }[];
};

export default function SkillUploadForm({ existingSkillNames = [] }: Props) {
  const t = useTranslations('skills');
  const router = useRouter();
  const [state, setState] = useState<UploadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  const getErrorMessage = (err: string): string => {
    if (err.includes('storage limit')) return t('errors.SKILL_SIZE_EXCEEDED');
    return err;
  };

  const checkAndReplace = async (zipBlob: Blob, fileName: string) => {
    setError(null);
    setState('uploading');

    try {
      const urlResult = await getSkillUploadUrl({ fileName, contentType: 'application/zip' });
      if (!urlResult?.data) throw new Error(t('errors.UPLOAD_FAILED'));

      const { url, key } = urlResult.data;

      const res = await fetch(url, {
        method: 'PUT',
        body: zipBlob,
        headers: { 'Content-Type': 'application/zip' },
      });
      if (!res.ok) throw new Error(t('errors.UPLOAD_FAILED'));

      setState('registering');

      const registerResult = await registerSkill({ s3Key: key });
      if (registerResult?.serverError) {
        throw new Error(registerResult.serverError);
      }
      if (registerResult?.data) {
        const newSkill = registerResult.data;
        const duplicate = existingSkillNames.find((s) => s.name === newSkill.name && s.SK !== newSkill.SK);
        if (duplicate) {
          if (confirm(t('confirmReplace'))) {
            await deleteSkill({ skillId: duplicate.SK });
          }
        }
      }

      router.refresh();
      setState('idle');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(getErrorMessage(msg));
      setState('idle');
    }
  };

  const handleZipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await checkAndReplace(file, file.name);
    if (zipInputRef.current) zipInputRef.current.value = '';
  };

  const handleDirImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setError(null);
    try {
      const zipData: Record<string, Uint8Array> = {};
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const path = file.webkitRelativePath;
        const parts = path.split('/');
        const relativePath = parts.slice(1).join('/');
        if (!relativePath) continue;
        const buf = await file.arrayBuffer();
        zipData[relativePath] = new Uint8Array(buf);
      }

      const zipped = zipSync(zipData);
      const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
      await checkAndReplace(blob, 'skill.zip');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(getErrorMessage(msg));
    }
    if (dirInputRef.current) dirInputRef.current.value = '';
  };

  const statusText = state === 'uploading' ? t('uploading') : state === 'registering' ? t('registering') : null;

  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <label className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 cursor-pointer disabled:opacity-50 transition-colors">
          <Upload className="h-4 w-4" />
          <span>{statusText ?? t('uploadZip')}</span>
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={handleZipUpload}
            disabled={state !== 'idle'}
          />
        </label>

        <label className="inline-flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 cursor-pointer disabled:opacity-50 transition-colors">
          <FolderOpen className="h-4 w-4" />
          <span>{statusText ?? t('importDir')}</span>
          <input
            ref={dirInputRef}
            type="file"
            className="hidden"
            onChange={handleDirImport}
            disabled={state !== 'idle'}
            {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
          />
        </label>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
