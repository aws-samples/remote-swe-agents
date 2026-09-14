/**
 * Rollback attachment recovery planning (pure logic, unit-tested).
 *
 * INVARIANT: after a failed submission, the submit-time attachment key set
 * must not be lost from the uploader (and therefore from the form values and
 * the persisted draft, both of which are derived from uploader state via the
 * fan-out effect). Whether a blob preview is still alive is irrelevant to
 * key survival: a key without a thumbnail still re-attaches the image on
 * resend, so the key set is the last line of defence against silent data
 * loss.
 *
 * The recovery pipeline for taken-over images on rollback:
 *   1. `planRollbackImageRestore` — blobs still owned/usable go straight
 *      back to the uploader (instant, zero network). Blobs already revoked
 *      (the pre-signed swap finished before the failure landed) can only be
 *      restored by key.
 *   2. `restoreFromKeys` (S3 HeadObject + pre-signed GET) rebuilds previews
 *      for the revoked keys. Keys missing from S3 are toasted and dropped —
 *      that is a legitimate drop (the object is gone server-side), not a
 *      silent one.
 *   3. `fallbackKeysForFailedLookup` — when the lookup itself fails (null:
 *      network etc.), NO key may be dropped: every revoked key re-enters the
 *      uploader as a key-only entry (placeholder thumbnail, key intact).
 *      Without this fallback the uploader fan-out (live subset only) would
 *      overwrite the rollback's full-snapshot draft save through the
 *      debounced watch effect, silently losing the revoked keys from both
 *      form and draft.
 */

export type TakenOverImage = { key: string; previewUrl: string };

export function planRollbackImageRestore(
  images: TakenOverImage[],
  isUsableFn: (url: string) => boolean
): { liveImages: TakenOverImage[]; revokedImageKeys: string[] } {
  const liveImages = images.filter((i) => isUsableFn(i.previewUrl));
  const revokedImageKeys = images.filter((i) => !isUsableFn(i.previewUrl)).map((i) => i.key);
  return { liveImages, revokedImageKeys };
}

export function fallbackKeysForFailedLookup(
  revokedImageKeys: string[],
  restored: { imageKeys: string[]; fileKeys: string[] } | null
): string[] {
  return restored === null ? revokedImageKeys : [];
}
