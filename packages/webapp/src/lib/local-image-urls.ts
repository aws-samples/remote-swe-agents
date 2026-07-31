/**
 * Ownership registry for the blob object URLs that back instant image
 * previews (`MessageView.localImageUrls`).
 *
 * Invariant: the CURRENT OWNER of a blob URL is the only party allowed to
 * decide its lifecycle (revoke it or keep it alive). A blob's ownership
 * moves as follows:
 *
 *   uploader --(takeoverAttachments)--> message
 *   message --(rollback: restoreTakenOverAttachments)--> uploader
 *   message --(pre-signed swap succeeded)--> revoked (terminal)
 *   uploader --(remove / clear / re-takeover)--> revoked or message
 *
 * Why a registry instead of purely local guards: the optimistic bubble's
 * `ImageViewer` starts an async getImageUrls → preload → revoke pipeline the
 * moment it mounts. A submission failure can roll the bubble back (unmount)
 * and hand the blob back to the uploader while that pipeline is still in
 * flight — the pipeline's completion must then NOT revoke a blob it no
 * longer owns. Conversely the pipeline can finish (blob revoked) before the
 * failure lands — the rollback must then NOT hand a dead blob back to the
 * uploader. Both sides consult this registry, so the decision is always made
 * against the current owner, not against stale closure state.
 *
 * `releaseFromMessage` only revokes while the message still owns the URL;
 * calls after ownership moved (or after revocation) are no-ops, so races
 * resolve safely regardless of ordering.
 *
 * Deferred release (`scheduleReleaseFromMessage`): an unmounting viewer
 * cannot distinguish "gone for good" (navigation — the blob would leak until
 * tab close) from "about to remount" (pending → confirmed re-render, React
 * StrictMode double-mount). Release is therefore scheduled with a grace
 * delay and a claim token: any re-claim within the grace window (a remount
 * claims on mount, a re-takeover claims at submit) invalidates the token and
 * keeps the blob alive.
 *
 * Module-scoped and memory-only, mirroring the lifetime of the blob URLs it
 * tracks (both die with the page).
 */

type LocalImageUrlOwner = 'message' | 'uploader' | 'revoked';

const owners = new Map<string, LocalImageUrlOwner>();
const claimTokens = new Map<string, number>();

export const RELEASE_GRACE_MS = 5_000;

export function claimForMessage(url: string): void {
  if (owners.get(url) === 'revoked') return;
  owners.set(url, 'message');
  claimTokens.set(url, (claimTokens.get(url) ?? 0) + 1);
}

export function returnToUploader(url: string): void {
  if (owners.get(url) === 'revoked') return;
  owners.set(url, 'uploader');
}

export function releaseFromMessage(url: string): void {
  if (owners.get(url) !== 'message') return;
  owners.set(url, 'revoked');
  try {
    URL.revokeObjectURL(url);
  } catch {}
}

/** Record a revocation performed by the uploader itself (remove / clear). */
export function markRevoked(url: string): void {
  owners.set(url, 'revoked');
}

/** Whether the URL may still be rendered / handed to a new owner. */
export function isUsable(url: string): boolean {
  return owners.get(url) !== 'revoked';
}

export function scheduleReleaseFromMessage(url: string, delayMs: number = RELEASE_GRACE_MS): void {
  const token = claimTokens.get(url);
  setTimeout(() => {
    if (claimTokens.get(url) === token) {
      releaseFromMessage(url);
    }
  }, delayMs);
}
