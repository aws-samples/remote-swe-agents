import type { KeyValueStorage } from './deployment-recovery';
import { extractStringArray } from './pending-resend';

/**
 * Persistence for attachment S3 keys alongside the text draft, so that
 * attachments survive ANY reload of the session page — manual reloads and
 * browser restarts included, not just the stale-deployment recovery flow
 * (which persists its own payload in sessionStorage only when a SUBMIT
 * fails). Without this, the draft text came back after a reload but the
 * attached images silently vanished.
 *
 * Only S3 object keys are stored (the objects were already uploaded via
 * pre-signed PUT and the image bucket has no expiring lifecycle rules);
 * binary data never enters localStorage. Restoration goes through the
 * uploader's `restoreFromKeys`, which verifies each key against S3 and
 * surfaces any that no longer exist.
 */

export type DraftAttachments = {
  imageKeys: string[];
  fileKeys: string[];
};

const keyFor = (formId: string) => `draft-attachments-${formId}`;

function defaultStorage(): KeyValueStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadDraftAttachments(
  formId: string,
  storage: KeyValueStorage | null = defaultStorage()
): DraftAttachments | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(keyFor(formId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as { imageKeys?: unknown; fileKeys?: unknown };
    const imageKeys = extractStringArray(candidate.imageKeys);
    const fileKeys = extractStringArray(candidate.fileKeys);
    if (imageKeys.length === 0 && fileKeys.length === 0) return null;
    return { imageKeys, fileKeys };
  } catch {
    return null;
  }
}

export function saveDraftAttachments(
  formId: string,
  attachments: DraftAttachments,
  storage: KeyValueStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    if (attachments.imageKeys.length === 0 && attachments.fileKeys.length === 0) {
      storage.removeItem(keyFor(formId));
    } else {
      storage.setItem(keyFor(formId), JSON.stringify(attachments));
    }
  } catch {}
}

export function clearDraftAttachments(formId: string, storage: KeyValueStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(keyFor(formId));
  } catch {}
}
