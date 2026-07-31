import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  claimForMessage,
  isUsable,
  markRevoked,
  releaseFromMessage,
  returnToUploader,
  scheduleReleaseFromMessage,
  RELEASE_GRACE_MS,
} from './local-image-urls';

// Each test uses a unique URL because the registry is module-scoped
// (mirroring the page-lifetime of real blob URLs).
let n = 0;
const freshUrl = () => `blob:https://example/test-${++n}`;

describe('local-image-urls ownership registry', () => {
  const revokeSpy = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    revokeSpy.mockClear();
    vi.stubGlobal('URL', { ...URL, revokeObjectURL: revokeSpy });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('swap success: message owner releases → revoked exactly once, no longer usable', () => {
    const url = freshUrl();
    claimForMessage(url);
    expect(isUsable(url)).toBe(true);
    releaseFromMessage(url);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(isUsable(url)).toBe(false);
    // Idempotent: a second (late) release is a no-op.
    releaseFromMessage(url);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });

  test('W1 race: rollback returns ownership to uploader → in-flight release becomes a no-op', () => {
    const url = freshUrl();
    claimForMessage(url); // takeover at submit
    returnToUploader(url); // rollback lands
    releaseFromMessage(url); // ImageViewer pipeline resolves late
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(isUsable(url)).toBe(true); // uploader previews keep working
  });

  test('W1 inverse race: swap revoked first → rollback must see the blob as unusable', () => {
    const url = freshUrl();
    claimForMessage(url);
    releaseFromMessage(url); // swap finished before the failure landed
    expect(isUsable(url)).toBe(false); // MessageForm falls back to restoreFromKeys
    // returning a revoked URL is a no-op, it cannot resurrect
    returnToUploader(url);
    expect(isUsable(url)).toBe(false);
  });

  test('W2: deferred release revokes after the grace window on permanent unmount', () => {
    const url = freshUrl();
    claimForMessage(url);
    scheduleReleaseFromMessage(url);
    expect(revokeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(isUsable(url)).toBe(false);
  });

  test('remount within the grace window re-claims and cancels the deferred release', () => {
    const url = freshUrl();
    claimForMessage(url); // mount 1
    scheduleReleaseFromMessage(url); // unmount 1 (pending → confirmed remount)
    claimForMessage(url); // mount 2 re-claims (token bump)
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(isUsable(url)).toBe(true);
  });

  test('deferred release after rollback is a no-op (uploader owns the blob)', () => {
    const url = freshUrl();
    claimForMessage(url);
    scheduleReleaseFromMessage(url); // viewer unmounts due to rollback
    returnToUploader(url); // rollback hands the blob back
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(isUsable(url)).toBe(true);
  });

  test('uploader-side revocation (remove/clear) is terminal', () => {
    const url = freshUrl();
    claimForMessage(url);
    returnToUploader(url);
    markRevoked(url); // uploader revoked it itself
    expect(isUsable(url)).toBe(false);
    claimForMessage(url); // a later claim cannot resurrect a dead URL
    expect(isUsable(url)).toBe(false);
    releaseFromMessage(url);
    expect(revokeSpy).not.toHaveBeenCalled(); // markRevoked does not double-revoke
  });
});
