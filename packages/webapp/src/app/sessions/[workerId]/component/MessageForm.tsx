'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
import { useAction } from 'next-safe-action/hooks';
import { Loader2, Send, Paperclip, Square } from 'lucide-react';
import { toast } from 'sonner';
import { sendMessageToAgent, updateSessionModel } from '../actions';
import { sendMessageToAgentSchema } from '../schemas';
import { KeyboardEventHandler, useCallback, useEffect, useRef } from 'react';
import { MessageView } from './MessageList';
import { useTranslations } from 'next-intl';
import { useImageUploader, type TakenOverAttachments } from '@/components/ImageUploader';
import {
  clearStaleDeploymentReloadGuard,
  isChunkLoadError,
  isStaleActionError,
  reloadForStaleDeployment,
} from '@/lib/deployment-recovery';
import {
  extractStringArray,
  hasPendingResend,
  salvageOptionalFields,
  savePendingResend,
  takePendingResend,
} from '@/lib/pending-resend';
import { clearDraftAttachments, loadDraftAttachments, saveDraftAttachments } from '@/lib/draft-attachments';
import { isUsable } from '@/lib/local-image-urls';
import { fallbackKeysForFailedLookup, planRollbackImageRestore } from '@/lib/rollback-attachments';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { KEYBOARD_OPEN_VIEWPORT_DELTA_PX, PINCH_ZOOM_SCALE_THRESHOLD } from '@/hooks/use-viewport-state';
import {
  ModelType,
  InferenceMode,
  getAvailableModelTypes,
  modelConfigs,
  kiroModelConfigs,
  getKiroModelIds,
  AgentStatus,
  KiroModelId,
} from '@remote-swe-agents/agent-core/schema';

const MAX_TEXTAREA_HEIGHT = 600;

/**
 * Resize the given textarea to fit its content (up to `MAX_TEXTAREA_HEIGHT`)
 * while preserving the user's visual scroll position on the page-level
 * `window` scroll. This is shared by every code path that mutates the
 * textarea height — the initial `autoResize` on input, the post-submit
 * reset, the optimistic-submit reset, the error rollback that restores
 * unsent text, and the draft-restore on mount — so that none of them can
 * re-introduce the "chat log pushed out of viewport" regression fixed in
 * #91.
 *
 * Ordering rationale:
 *   1. Capture `window.scrollY` first. This read does NOT flush layout, so
 *      it is safe even before we measure the textarea. We must capture it
 *      before the `height: 'auto'` mutation, because the intermediate
 *      reflow can clamp `scrollY` to the new max and corrupt the
 *      compensation basis.
 *   2. Do the `height: 'auto'` + `scrollHeight` measurement, compute the
 *      final height, and early-return if unchanged — this avoids any
 *      work on no-op calls (e.g. a keystroke that produces the same
 *      wrapped height).
 *   3. Apply the new height, then compensate the page scroll by exactly
 *      `heightDiff`. Because the textarea is the only element whose
 *      height changed in this frame, `scrollBefore + heightDiff` keeps
 *      every pixel above the textarea visually pinned to where it was,
 *      including the "pinned to bottom" case (the maths collapse: the
 *      post-mutation max scroll equals `scrollBefore + heightDiff`
 *      whenever the user was previously at the max). No read of
 *      `document.documentElement.scrollHeight` is required.
 *
 * Mobile keyboard exception:
 *   When a soft keyboard is open (detected via `visualViewport.height`
 *   shrinkage, excluding pinch-zoom), the re-anchor step is skipped
 *   because per-keystroke `window.scrollTo` calls collide with the
 *   keyboard's slide-in animation and cause the viewport to jump on
 *   every character. The height mutation itself still runs, so the
 *   textarea grows as expected; only the scroll compensation is
 *   suppressed. Desktop is unaffected because `innerHeight` and
 *   `visualViewport.height` match.
 */
function adjustTextareaHeightWithScrollAnchor(textarea: HTMLTextAreaElement) {
  // (1) Cheap capture before any DOM mutation.
  const scrollBefore = window.scrollY;

  // (2) Measure and compute new height.
  const currentHeight = textarea.style.height;
  textarea.style.height = 'auto';
  const scrollHeight = textarea.scrollHeight;
  const newHeight = Math.min(scrollHeight, MAX_TEXTAREA_HEIGHT);
  const newHeightPx = `${newHeight}px`;

  // Early return on no-op. Restore the original inline height so we don't
  // leave `auto` applied when the caller was only probing for a resize.
  if (currentHeight === newHeightPx) {
    textarea.style.height = currentHeight;
    return;
  }

  const oldHeight = parseFloat(currentHeight) || textarea.offsetHeight;
  const heightDiff = newHeight - oldHeight;

  // Apply the final height and the overflow mode for `max-height` clamping.
  textarea.style.height = newHeightPx;
  textarea.style.overflowY = scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';

  // Skip the page-scroll re-anchor while the mobile virtual keyboard is
  // open. The `scale <= 1.01` guard excludes pinch-zoom, which also
  // shrinks `visualViewport.height`. See the function-level JSDoc for
  // the full rationale.
  const visualViewport = window.visualViewport;
  const keyboardOpen =
    !!visualViewport &&
    visualViewport.scale <= PINCH_ZOOM_SCALE_THRESHOLD &&
    window.innerHeight - visualViewport.height > KEYBOARD_OPEN_VIEWPORT_DELTA_PX;
  if (keyboardOpen) {
    return;
  }

  // (3) Compensate the page scroll by exactly the height delta. Because
  // the textarea is the only element whose height changed, this keeps
  // every pixel above the textarea visually pinned. It also subsumes
  // the "user was pinned to the bottom" case without a separate
  // `wasAtBottom` branch: if the user was at the max scroll, then
  // post-mutation `scrollBefore + heightDiff` equals the new max.
  if (heightDiff !== 0) {
    window.scrollTo({ top: scrollBefore + heightDiff, behavior: 'instant' });
  }
}

type MessageFormProps = {
  onSubmit: (message: MessageView) => void;
  onConfirm: (pendingId: string, confirmedId: string) => void;
  onRollback: (pendingId: string) => void;
  workerId: string;
  defaultModelOverride: ModelType;
  /**
   * Display name of the currently signed-in user. When set, the optimistic
   * pending bubble the submitter sees carries
   * `userSenderDisplayName = currentUserDisplayName`, so their own message
   * is labelled with their name instead of the generic "User". The server
   * rebroadcast fires with the same field; `SessionPageClient`'s
   * `case 'message'` dedupe recognizes the echo by clientId and merges it
   * onto the existing bubble instead of adding a second one, so the bubble
   * label does not flicker between "User" → "<name>".
   */
  currentUserDisplayName?: string;
  /**
   * Stable Cognito user id of the currently signed-in user. Mirrors
   * `senderUserId` on the server-side rebroadcast so that the optimistic
   * bubble carries the same `userSenderUserId` as the rebroadcast variant
   * — important for `MessageList` grouping (see `getMessageSenderKey`).
   */
  currentUserId?: string;
  /**
   * Effective inference mode for this session. When `'kiro-cli'` the Bedrock
   * model selector is replaced with a Kiro model selector that lets the user
   * swap the model per message via the `/model` slash command in kiro-cli.
   */
  inferenceMode?: InferenceMode;
  /**
   * Default Kiro model for this session, resolved server-side as
   * `session.kiroModel > userPrefs.kiroModel > 'auto'`. Used as the initial
   * value of the per-message selector on Kiro sessions.
   */
  kiroModel?: string;
  agentStatus?: AgentStatus;
  onInterrupt?: () => void;
};

export default function MessageForm({
  onSubmit,
  onConfirm,
  onRollback,
  workerId,
  defaultModelOverride,
  currentUserDisplayName,
  currentUserId,
  inferenceMode,
  kiroModel,
  agentStatus,
  onInterrupt,
}: MessageFormProps) {
  const t = useTranslations('sessions');
  const draftStorageKey = `draft-message-${workerId}`;

  const isKiroSession = inferenceMode === 'kiro-cli';
  const kiroModelIds = getKiroModelIds();
  const defaultKiroModel = kiroModel && kiroModel in kiroModelConfigs ? kiroModel : 'auto';

  const isAgentWorking = agentStatus === 'working';

  const { execute: executeUpdateModel } = useAction(updateSessionModel, {
    onError: () => {
      toast.error(t('modelUpdateFailed'));
    },
  });
  const modelUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingModelChangeRef = useRef<{ field: 'bedrock' | 'kiro'; value: string } | null>(null);

  const flushModelChange = useCallback(() => {
    if (modelUpdateTimeoutRef.current) {
      clearTimeout(modelUpdateTimeoutRef.current);
      modelUpdateTimeoutRef.current = null;
    }
    const pending = pendingModelChangeRef.current;
    if (pending) {
      pendingModelChangeRef.current = null;
      if (pending.field === 'bedrock') {
        executeUpdateModel({ workerId, bedrockDefaultModel: pending.value as ModelType });
      } else {
        executeUpdateModel({ workerId, kiroDefaultModel: pending.value as KiroModelId });
      }
    }
  }, [workerId, executeUpdateModel]);

  useEffect(() => {
    return () => {
      flushModelChange();
    };
  }, [flushModelChange]);

  const handleModelChange = useCallback(
    (field: 'bedrock' | 'kiro', value: string) => {
      pendingModelChangeRef.current = { field, value };
      if (modelUpdateTimeoutRef.current) {
        clearTimeout(modelUpdateTimeoutRef.current);
      }
      modelUpdateTimeoutRef.current = setTimeout(() => {
        modelUpdateTimeoutRef.current = null;
        pendingModelChangeRef.current = null;
        if (field === 'bedrock') {
          executeUpdateModel({ workerId, bedrockDefaultModel: value as ModelType });
        } else {
          executeUpdateModel({ workerId, kiroDefaultModel: value as KiroModelId });
        }
      }, 300);
    },
    [workerId, executeUpdateModel]
  );

  const pendingRef = useRef<{
    id: string;
    message: string;
    /**
     * Attachment keys captured at submit time. The error handlers MUST read
     * these instead of `getValues('imageKeys'/'fileKeys')`: the uploader is
     * cleared optimistically at submit (its previews move into the chat
     * bubble), so by the time an error lands the form values have been
     * fanned back to [].
     */
    imageKeys: string[];
    fileKeys: string[];
    /**
     * Blob-preview attachments taken over from the uploader at submit time
     * (ownership transfer, see `takeoverAttachments`). On rollback they are
     * handed back to the uploader so the previews reappear instantly.
     */
    takenOver: TakenOverAttachments;
  } | null>(null);

  /**
   * Attachment keys of an auto-resend consumed from sessionStorage. When the
   * resent submission fails again with a non-stale error, the fresh page has
   * no uploader state to show the still-attached objects — this ref lets the
   * error handler rebuild the previews from the persisted S3 keys.
   */
  const resendAttachmentsRef = useRef<{ imageKeys: string[]; fileKeys: string[] } | null>(null);

  const {
    form: { register, formState, reset, watch, setValue, getValues },
    action: { isExecuting },
    handleSubmitWithAction,
  } = useHookFormAction(sendMessageToAgent, zodResolver(sendMessageToAgentSchema), {
    actionProps: {
      onSuccess: (args) => {
        if (args.data && pendingRef.current) {
          onConfirm(pendingRef.current.id, args.data.item.SK);
        }
        pendingRef.current = null;
        resendAttachmentsRef.current = null;
        try {
          clearStaleDeploymentReloadGuard(window.sessionStorage);
        } catch {}
        reset();
        setValue('modelOverride', args.input.modelOverride);
        setValue('kiroModelOverride', args.input.kiroModelOverride);
        clearImagesRef.current();
        try {
          localStorage.removeItem(draftStorageKey);
        } catch {}
        clearDraftAttachments(workerId);
        if (textareaRef.current) {
          adjustTextareaHeightWithScrollAnchor(textareaRef.current);
        }
      },
      onError: ({ error }) => {
        // A stale build (the app was redeployed while this tab was open)
        // makes the server reject the Server Action ID with 404 +
        // `x-nextjs-action-not-found` BEFORE executing it, so it is safe to
        // reload onto the new build and automatically re-submit
        // (mode: 'resend'). A ChunkLoadError also indicates a stale build,
        // but carries no guarantee the action did not execute — for that
        // class we only persist the input for restoration after the reload
        // (mode: 'restore'), never auto-resubmit (S1).
        // The submission (text + already-uploaded attachment keys) survives
        // the reload in sessionStorage; the draft is also re-saved to
        // localStorage as insurance against sessionStorage quota failures.
        // `reloadForStaleDeployment` is loop-guarded: if the attempt budget
        // is exhausted, it returns false and we fall through to the regular
        // rollback + toast below.
        const staleAction = isStaleActionError(error.thrownError);
        if (pendingRef.current && (staleAction || isChunkLoadError(error.thrownError))) {
          try {
            localStorage.setItem(draftStorageKey, pendingRef.current.message);
          } catch {}
          saveDraftAttachments(workerId, {
            imageKeys: pendingRef.current.imageKeys,
            fileKeys: pendingRef.current.fileKeys,
          });
          savePendingResend(`message-${workerId}`, {
            mode: staleAction ? 'resend' : 'restore',
            values: {
              message: pendingRef.current.message,
              imageKeys: pendingRef.current.imageKeys,
              fileKeys: pendingRef.current.fileKeys,
            },
            clientId: getValues('clientId'),
          });
          if (reloadForStaleDeployment()) {
            return;
          }
          takePendingResend(`message-${workerId}`);
        }
        if (pendingRef.current) {
          onRollback(pendingRef.current.id);
          // Re-persist both drafts, undoing the submit-time clear: the text
          // draft re-saves through the watch-driven debounce triggered by
          // this setValue; the attachment previews were taken over by the
          // (now rolled-back) optimistic bubble, so hand them back to the
          // uploader — blob URLs are reused as-is, no network round trip —
          // and re-save the keys explicitly from the submit-time snapshot.
          setValue('message', pendingRef.current.message, { shouldValidate: true });
          // Partition the taken-over blobs by current ownership state: the
          // bubble's ImageViewer may have already completed its pre-signed
          // swap (and revoked the blob) before this failure landed. Live
          // blobs go straight back to the uploader (zero network); revoked
          // ones are restored via restoreFromKeys (pre-signed lookup). If
          // that lookup itself fails, the keys re-enter the uploader as
          // key-only placeholder entries — the submit-time key set must
          // never be lost from uploader-derived state (form values + draft),
          // or a resend would silently drop the image (W-A; invariant
          // pinned in lib/rollback-attachments.test.ts).
          const { takenOver } = pendingRef.current;
          const { liveImages, revokedImageKeys } = planRollbackImageRestore(takenOver.images, isUsable);
          restoreTakenOverRef.current({ images: liveImages, files: takenOver.files });
          if (revokedImageKeys.length > 0) {
            void restoreFromKeysRef.current(revokedImageKeys, []).then((restored) => {
              const fallbackKeys = fallbackKeysForFailedLookup(revokedImageKeys, restored);
              if (fallbackKeys.length > 0) {
                restoreKeyOnlyImagesRef.current(fallbackKeys);
              }
            });
          }
          saveDraftAttachments(workerId, {
            imageKeys: pendingRef.current.imageKeys,
            fileKeys: pendingRef.current.fileKeys,
          });

          pendingRef.current = null;
          requestAnimationFrame(() => {
            if (textareaRef.current) {
              adjustTextareaHeightWithScrollAnchor(textareaRef.current);
            }
          });
        }
        if (resendAttachmentsRef.current) {
          const { imageKeys, fileKeys } = resendAttachmentsRef.current;
          resendAttachmentsRef.current = null;
          void restoreFromKeysRef.current(imageKeys, fileKeys);
        }
        toast.error(typeof error === 'string' ? error : 'Failed to send the message');
      },
    },
    formProps: {
      defaultValues: {
        message: '',
        workerId: workerId,
        imageKeys: [],
        fileKeys: [],
        modelOverride: defaultModelOverride,
        kiroModelOverride: defaultKiroModel,
      },
    },
  });

  const clearImagesRef = useRef<() => void>(() => {});
  const restoreFromKeysRef = useRef<
    (imageKeys: string[], fileKeys: string[]) => Promise<{ imageKeys: string[]; fileKeys: string[] } | null>
  >(async () => null);
  const restoreTakenOverRef = useRef<(attachments: TakenOverAttachments) => void>(() => {});
  const restoreKeyOnlyImagesRef = useRef<(keys: string[]) => void>(() => {});

  // Restore draft message from localStorage on mount
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    try {
      const savedDraft = localStorage.getItem(draftStorageKey);
      if (savedDraft) {
        // `shouldValidate` is required here: without it react-hook-form keeps
        // the mount-time `isValid` (computed against the empty default), so
        // the restored draft sat in the textarea while the send button stayed
        // disabled until the user typed another character.
        setValue('message', savedDraft, { shouldValidate: true });
        // Restore textarea height after setting value
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            adjustTextareaHeightWithScrollAnchor(textareaRef.current);
          }
        });
      }
    } catch {}
  }, [draftStorageKey, setValue]);

  // Restore draft attachment keys (previews + form keys) on mount so
  // attachments survive ANY reload — manual reloads and browser restarts
  // included, matching the text draft above. Restoration goes through
  // `restoreFromKeys`, which verifies every key against S3 and gracefully
  // drops (with a toast) any that no longer exist.
  //
  // Exclusivity with the stale-deployment recovery payload: when a
  // pending-resend payload exists for this mount, the payload is the single
  // owner of attachment state (the consume effect below either auto-resubmits
  // the keys or restores them through the same restoreFromKeys path), so the
  // draft-side restore is skipped entirely — otherwise the two sources could
  // stack the same attachments twice. The check works because React runs
  // effects in declaration order: this effect runs BEFORE the consume effect,
  // while the payload is still in sessionStorage, so the non-consuming
  // `hasPendingResend` peek can still observe it.
  //
  // `draftAttachmentsPersistEnabledRef` gates the save effect below until the
  // restore has settled, so the uploader's initial empty fan-out cannot wipe
  // the stored keys before they are read back.
  const draftAttachmentsConsumedRef = useRef(false);
  const draftAttachmentsPersistEnabledRef = useRef(false);
  useEffect(() => {
    if (draftAttachmentsConsumedRef.current) return;
    draftAttachmentsConsumedRef.current = true;
    if (hasPendingResend(`message-${workerId}`)) {
      draftAttachmentsPersistEnabledRef.current = true;
      return;
    }
    const saved = loadDraftAttachments(workerId);
    if (!saved) {
      draftAttachmentsPersistEnabledRef.current = true;
      return;
    }
    requestAnimationFrame(() => {
      void restoreFromKeysRef
        .current(saved.imageKeys, saved.fileKeys)
        .then((restored) => {
          // Rewrite the entry with the subset that actually still exists in
          // S3 (an empty subset removes it), so a key that was deleted
          // server-side cannot re-toast "could not be restored" on every
          // subsequent reload. On lookup failure (null) the entry is kept so
          // the next mount retries. No race with the persist gate below:
          // this write goes directly to storage and is NOT gated by
          // `draftAttachmentsPersistEnabledRef` (the gate only guards the
          // watch-driven save effect), and `.finally` runs after `.then`, so
          // the gate opens only after the rewrite has landed. Any later
          // fan-out-driven save just rewrites the same subset.
          if (restored) {
            saveDraftAttachments(workerId, restored);
          }
        })
        .finally(() => {
          draftAttachmentsPersistEnabledRef.current = true;
        });
    });
  }, [workerId]);

  // Consume a pending submission persisted by the stale-deployment handler
  // (see onError above). mode 'resend' re-submits automatically on the fresh
  // build; mode 'restore' only repopulates the form and lets the user press
  // send. `takePendingResend` removes the payload before acting, so the
  // auto-resend can only ever fire once per persisted failure.
  //
  // A resend crosses a deployment boundary: the values were produced by the
  // OLD build and are validated by the NEW build's schema (model enums in
  // particular change between deploys). Optional fields are salvaged one by
  // one — only the fields that are actually invalid are dropped (with a
  // toast telling the user), and when the message itself cannot be recovered
  // the payload degrades to a draft restore — never a submission that would
  // fail resolver validation and strand the optimistic bubble.
  const resendConsumedRef = useRef(false);
  useEffect(() => {
    if (resendConsumedRef.current) return;
    resendConsumedRef.current = true;
    const pending = takePendingResend<Record<string, unknown>>(`message-${workerId}`);
    if (!pending) return;
    const raw = pending.values;
    const message = typeof raw.message === 'string' ? raw.message : '';
    if (!message.trim()) return;
    const imageKeys = extractStringArray(raw.imageKeys);
    const fileKeys = extractStringArray(raw.fileKeys);
    const { values: optionals, dropped } = salvageOptionalFields(sendMessageToAgentSchema.shape, raw, [
      'modelOverride',
      'kiroModelOverride',
    ]);
    const parsed = sendMessageToAgentSchema.safeParse({ workerId, message, imageKeys, fileKeys, ...optionals });
    const canResend = pending.mode === 'resend' && parsed.success;
    const values = parsed.success ? parsed.data : { workerId, message, imageKeys, fileKeys };
    const clientIdParse = sendMessageToAgentSchema.shape.clientId.safeParse(pending.clientId);
    const clientId = clientIdParse.success ? clientIdParse.data : undefined;
    resendAttachmentsRef.current = { imageKeys: values.imageKeys ?? [], fileKeys: values.fileKeys ?? [] };
    // Defer past the mount effects (the uploader's initial fan-out resets
    // imageKeys/fileKeys to []) so the restored values are the ones submitted.
    requestAnimationFrame(() => {
      setValue('message', values.message, { shouldValidate: true });
      if ('modelOverride' in values && values.modelOverride) {
        setValue('modelOverride', values.modelOverride);
      }
      if ('kiroModelOverride' in values && values.kiroModelOverride) {
        setValue('kiroModelOverride', values.kiroModelOverride);
      }
      if (textareaRef.current) {
        adjustTextareaHeightWithScrollAnchor(textareaRef.current);
      }
      if (dropped.length > 0) {
        toast.warning(t('settingsNotCarriedOver'));
      }
      if (canResend) {
        setValue('imageKeys', values.imageKeys ?? []);
        setValue('fileKeys', values.fileKeys ?? []);
        // Explain WHY the page just reloaded; the resent message itself is
        // visible in the timeline, so its success is not announced.
        toast.info(t('reloadedAfterUpdate'));
        handleOptimisticSubmitRef.current(undefined, { clientId });
      } else {
        // Restore-only: bring back the attachment previews (which fan the
        // restorable keys into the form) and let the user submit manually.
        resendAttachmentsRef.current = null;
        void restoreFromKeysRef.current(values.imageKeys ?? [], values.fileKeys ?? []);
        toast.info(t('messageRestoredAfterUpdate'));
      }
    });
  }, [workerId, setValue, t]);

  // Save draft message to localStorage on change
  const messageValue = watch('message');
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      try {
        if (messageValue) {
          localStorage.setItem(draftStorageKey, messageValue);
        } else {
          localStorage.removeItem(draftStorageKey);
        }
      } catch {}
    }, 300);
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [messageValue, draftStorageKey]);

  // Save draft attachment keys to localStorage on change — same debounce and
  // clearing semantics as the text draft above (an empty key set removes the
  // entry, and a successful send clears it via clearDraftAttachments in
  // onSuccess), so both drafts share one lifecycle.
  const imageKeysValue = watch('imageKeys');
  const fileKeysValue = watch('fileKeys');
  const attachmentsSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!draftAttachmentsPersistEnabledRef.current) return;
    if (attachmentsSaveTimeoutRef.current) {
      clearTimeout(attachmentsSaveTimeoutRef.current);
    }
    attachmentsSaveTimeoutRef.current = setTimeout(() => {
      saveDraftAttachments(workerId, { imageKeys: imageKeysValue ?? [], fileKeys: fileKeysValue ?? [] });
    }, 300);
    return () => {
      if (attachmentsSaveTimeoutRef.current) {
        clearTimeout(attachmentsSaveTimeoutRef.current);
      }
    };
  }, [imageKeysValue, fileKeysValue, workerId]);

  const { ref: messageRef, ...messageRegister } = register('message');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    adjustTextareaHeightWithScrollAnchor(textarea);
  }, []);

  const enterPost: KeyboardEventHandler = (keyEvent) => {
    if (isExecuting || isUploading) return;
    if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.altKey || keyEvent.metaKey)) {
      handleOptimisticSubmit();
    }
  };

  const {
    uploadingImages,
    uploadingFiles,
    handleFileSelect,
    handlePaste,
    ImagePreviewList,
    clearImages,
    restoreFromKeys,
    restoreKeyOnlyImages,
    takeoverAttachments,
    restoreTakenOverAttachments,
    isUploading: isUploadingFiles,
  } = useImageUploader({
    workerId,
    onImagesChange: (imageKeys) => {
      setValue('imageKeys', imageKeys);
    },
    onFilesChange: (fileKeys) => {
      setValue('fileKeys', fileKeys);
    },
  });

  // Latest-ref pattern: these refs are consumed by the mount-time
  // auto-resend effect (declared earlier, so it runs first). They must be
  // assigned during render — before any effect runs — for that effect to
  // see the current callbacks; an effect-based sync would run too late.
  clearImagesRef.current = clearImages;
  // eslint-disable-next-line react-hooks/immutability
  restoreFromKeysRef.current = restoreFromKeys;
  restoreTakenOverRef.current = restoreTakenOverAttachments;
  restoreKeyOnlyImagesRef.current = restoreKeyOnlyImages;

  const isUploading = isUploadingFiles;

  const handleOptimisticSubmit = useCallback(
    (e?: React.BaseSyntheticEvent, opts?: { clientId?: string }) => {
      const message = getValues('message');
      flushModelChange();
      if (message?.trim()) {
        // Generate a per-submission UUID. The optimistic bubble carries it
        // locally; we also stamp it on the form so the server action
        // forwards the same id verbatim onto the realtime rebroadcast.
        // When that rebroadcast lands on this tab, `dedup.ts` matches by
        // id and merges the event's attachment keys onto the existing
        // bubble instead of rendering a duplicate. Replaces the older
        // body-content + 30s window heuristic.
        //
        // `crypto.randomUUID()` is supported in all evergreen browsers and
        // in Next.js's secure contexts. If it is somehow unavailable
        // (e.g. legacy headless test environment), we fall back to a
        // collision-resistant `pending-` + Date.now() string — that path
        // loses dedup but never crashes the submit.
        //
        // The stale-deployment auto-resend passes the ORIGINAL submission's
        // clientId via `opts` so the retried message keeps a stable identity.
        const clientId =
          opts?.clientId ??
          (typeof globalThis.crypto?.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        setValue('clientId', clientId);
        const pendingId = `pending-${Date.now()}`;
        // Snapshot the attachment keys BEFORE taking over the previews: the
        // takeover clears the uploader, whose fan-out effect resets the form
        // values to [] after this handler returns. react-hook-form snapshots
        // `_formValues` synchronously inside `handleSubmitWithAction` below,
        // so the in-flight submission still carries the keys — but the error
        // handlers run much later and must use this snapshot (via pendingRef).
        const imageKeys = getValues('imageKeys') ?? [];
        const fileKeys = getValues('fileKeys') ?? [];
        // Ownership transfer: the blob preview URLs move from the uploader
        // strip into the optimistic bubble, so the just-sent image renders
        // instantly (no network) and is not displayed twice. `ImageViewer`
        // revokes each blob after swapping in the real pre-signed URL; on
        // rollback the blobs are handed back to the uploader instead.
        const takenOver = takeoverAttachments();
        const localImageUrls = Object.fromEntries(
          takenOver.images.filter((i) => i.previewUrl).map((i) => [i.key, i.previewUrl])
        );
        pendingRef.current = {
          id: pendingId,
          message,
          imageKeys,
          fileKeys,
          takenOver,
        };
        onSubmit({
          id: pendingId,
          role: 'user',
          content: message,
          timestamp: new Date(),
          type: 'message',
          pending: true,
          clientId,
          ...(imageKeys.length > 0 ? { imageKeys } : {}),
          ...(fileKeys.length > 0 ? { fileKeys } : {}),
          ...(Object.keys(localImageUrls).length > 0 ? { localImageUrls } : {}),
          // Label the optimistic bubble with the submitter's own display
          // name so they see "<displayName>" instead of the generic
          // "User" while the server action is in flight. The server
          // rebroadcast carries the same field and the `case 'message'`
          // dedupe path merges the echo onto this bubble, so the label is
          // stable.
          ...(currentUserDisplayName ? { userSenderDisplayName: currentUserDisplayName } : {}),
          ...(currentUserId ? { userSenderUserId: currentUserId } : {}),
          userSenderType: 'webapp',
        });
        // Clear both drafts at SUBMIT time rather than waiting for
        // onSuccess: if the tab unmounts while the action is in flight, an
        // onSuccess-only clear would leave the just-sent text/attachments in
        // localStorage and resurrect them on the next open ("my previous
        // image is attached again"). Losing the draft on failure is covered:
        // every failure path re-saves — the onError rollback re-persists
        // both drafts, and the stale-deployment branch additionally writes
        // the pending-resend payload before reloading.
        try {
          localStorage.removeItem(draftStorageKey);
        } catch {}
        clearDraftAttachments(workerId);
      }
      handleSubmitWithAction(e);
      setValue('message', '');
      if (textareaRef.current) {
        adjustTextareaHeightWithScrollAnchor(textareaRef.current);
      }
    },
    [
      getValues,
      onSubmit,
      handleSubmitWithAction,
      setValue,
      takeoverAttachments,
      currentUserDisplayName,
      currentUserId,
      draftStorageKey,
      workerId,
      flushModelChange,
    ]
  );

  // Latest-submit ref so the mount-time auto-resend effect (declared before
  // the uploader hook this callback depends on) can invoke it safely.
  const handleOptimisticSubmitRef = useRef(handleOptimisticSubmit);
  // eslint-disable-next-line react-hooks/immutability
  handleOptimisticSubmitRef.current = handleOptimisticSubmit;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="max-w-4xl mx-auto px-4 py-4">
        <form onSubmit={handleOptimisticSubmit} className="flex flex-col gap-4">
          <ImagePreviewList />

          <div className="border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus-within:border-gray-400 dark:focus-within:border-gray-500">
            <textarea
              // https://qiita.com/P-man_Brown/items/63fc7d281baae22c74e5
              {...messageRegister}
              ref={(e) => {
                messageRef(e);
                // Ref-callback assignment (not a render-phase write): this is
                // the standard way to fan a node out to a second ref.
                // eslint-disable-next-line react-hooks/immutability
                textareaRef.current = e;
              }}
              placeholder={isUploading ? t('waitingForImageUpload') : t('enterYourMessage')}
              className="w-full resize-none border-0 bg-transparent text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 px-4 pt-3 pb-3 focus:outline-none focus:ring-0 min-h-[2rem] overflow-hidden"
              disabled={isExecuting || isUploading}
              onKeyDown={enterPost}
              onPaste={handlePaste}
              onInput={autoResize}
            />

            <div className="flex items-center justify-between px-2 pb-2">
              <div className="flex gap-1">
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        onClick={handleFileSelect}
                        disabled={isExecuting}
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-600"
                      >
                        <Paperclip className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('attachFile')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>

              <div className="flex gap-2 items-center">
                {isKiroSession ? (
                  <select
                    {...register('kiroModelOverride', {
                      onChange: (e) => handleModelChange('kiro', e.target.value),
                    })}
                    disabled={isExecuting}
                    aria-label={t('kiroModelSelector')}
                    className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 dark:text-white focus:outline-none"
                  >
                    {kiroModelIds.map((id) => (
                      <option key={id} value={id}>
                        {kiroModelConfigs[id]?.name ?? id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select
                    {...register('modelOverride', {
                      onChange: (e) => handleModelChange('bedrock', e.target.value),
                    })}
                    disabled={isExecuting}
                    className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 dark:text-white focus:outline-none"
                  >
                    {getAvailableModelTypes().map((type) => (
                      <option key={type} value={type}>
                        {modelConfigs[type].name}
                      </option>
                    ))}
                  </select>
                )}
                {isAgentWorking && !isExecuting && !messageValue?.trim() ? (
                  <TooltipProvider delayDuration={100}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          onClick={onInterrupt}
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                        >
                          <Square className="w-5 h-5 fill-current" strokeWidth={2.5} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('forceStopEscape')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <TooltipProvider delayDuration={100}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="submit"
                          disabled={!formState.isValid || isExecuting || isUploading}
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                        >
                          {isExecuting ? (
                            <Loader2 className="w-6 h-6 animate-spin" strokeWidth={2.5} />
                          ) : isUploading ? (
                            <Loader2 className="w-6 h-6 animate-spin" strokeWidth={2.5} />
                          ) : (
                            <Send className="w-6 h-6" strokeWidth={2.5} />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('sendWithCtrlEnter')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
          </div>

          <input hidden {...register('workerId')} />
          <input hidden {...register('imageKeys')} />
          <input hidden {...register('fileKeys')} />
        </form>
      </div>
    </div>
  );
}
