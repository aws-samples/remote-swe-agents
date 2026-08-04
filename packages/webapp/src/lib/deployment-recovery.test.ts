import { describe, expect, it } from 'vitest';
// Deep import into Next.js internals: there is no public export of the
// UnrecognizedActionError class itself (only the unstable type guard in
// 'next/navigation'). Re-verify this path when upgrading Next.js.
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import {
  FORM_RECOVERY_IN_FLIGHT_MS,
  RELOAD_ATTEMPTS_RESET_MS,
  RELOAD_GUARD_WINDOW_MS,
  RELOAD_MAX_ATTEMPTS,
  canReloadForStaleDeployment,
  classifyStaleDeploymentError,
  clearStaleDeploymentReloadGuard,
  isChunkLoadError,
  isStaleActionError,
  markStaleDeploymentReload,
  type KeyValueStorage,
} from './deployment-recovery';

function fakeStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function staleActionError() {
  return new UnrecognizedActionError('Server Action "deadbeef" was not found on the server.');
}

function chunkLoadError() {
  const error = new Error('Loading chunk 123 failed.');
  error.name = 'ChunkLoadError';
  return error;
}

describe('isStaleActionError', () => {
  it('detects UnrecognizedActionError thrown for stale Server Action IDs', () => {
    expect(isStaleActionError(staleActionError())).toBe(true);
  });

  it('does not match ordinary errors or chunk errors', () => {
    expect(isStaleActionError(new Error('Session not found'))).toBe(false);
    expect(isStaleActionError(chunkLoadError())).toBe(false);
    expect(isStaleActionError('Failed to find Server Action')).toBe(false);
    expect(isStaleActionError(undefined)).toBe(false);
    expect(isStaleActionError(null)).toBe(false);
  });
});

describe('isChunkLoadError', () => {
  it('detects webpack chunk load errors by name', () => {
    expect(isChunkLoadError(chunkLoadError())).toBe(true);
  });

  it('detects chunk load errors by message when name is generic', () => {
    expect(isChunkLoadError(new Error('Loading chunk app/foo failed. (error: https://x/chunk.js)'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk 42 failed.'))).toBe(true);
  });

  it('does not match ordinary errors or stale action errors', () => {
    expect(isChunkLoadError(new Error('Session not found'))).toBe(false);
    expect(isChunkLoadError(staleActionError())).toBe(false);
  });

  it('handles non-object inputs safely', () => {
    expect(isChunkLoadError('ChunkLoadError')).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
  });
});

describe('reload loop guard', () => {
  it('allows the first reload and blocks reloads within the guard window', () => {
    const storage = fakeStorage();
    const t0 = 1_000_000;
    expect(canReloadForStaleDeployment(storage, t0)).toBe(true);
    markStaleDeploymentReload(storage, t0);
    expect(canReloadForStaleDeployment(storage, t0 + 1)).toBe(false);
    expect(canReloadForStaleDeployment(storage, t0 + RELOAD_GUARD_WINDOW_MS - 1)).toBe(false);
  });

  it('allows a reload again after the guard window has passed', () => {
    const storage = fakeStorage();
    const t0 = 1_000_000;
    markStaleDeploymentReload(storage, t0);
    expect(canReloadForStaleDeployment(storage, t0 + RELOAD_GUARD_WINDOW_MS)).toBe(true);
  });

  it('caps the number of automatic reload attempts (no indefinite reloading)', () => {
    const storage = fakeStorage();
    let now = 1_000_000;
    for (let attempt = 0; attempt < RELOAD_MAX_ATTEMPTS; attempt++) {
      expect(canReloadForStaleDeployment(storage, now)).toBe(true);
      markStaleDeploymentReload(storage, now);
      now += RELOAD_GUARD_WINDOW_MS;
    }
    // The next attempt after the sliding window is denied by the hard cap.
    expect(canReloadForStaleDeployment(storage, now)).toBe(false);
    expect(canReloadForStaleDeployment(storage, now + RELOAD_GUARD_WINDOW_MS)).toBe(false);
  });

  it('resets the attempt counter after the reset horizon', () => {
    const storage = fakeStorage();
    let now = 1_000_000;
    for (let attempt = 0; attempt < RELOAD_MAX_ATTEMPTS; attempt++) {
      markStaleDeploymentReload(storage, now);
      now += RELOAD_GUARD_WINDOW_MS;
    }
    expect(canReloadForStaleDeployment(storage, now)).toBe(false);
    expect(canReloadForStaleDeployment(storage, now + RELOAD_ATTEMPTS_RESET_MS)).toBe(true);
  });

  it('resets the attempt counter when cleared (e.g. after a successful send)', () => {
    const storage = fakeStorage();
    let now = 1_000_000;
    for (let attempt = 0; attempt < RELOAD_MAX_ATTEMPTS; attempt++) {
      markStaleDeploymentReload(storage, now);
      now += RELOAD_GUARD_WINDOW_MS;
    }
    expect(canReloadForStaleDeployment(storage, now)).toBe(false);
    clearStaleDeploymentReloadGuard(storage);
    expect(canReloadForStaleDeployment(storage, now)).toBe(true);
  });

  it('treats a corrupted guard value as reloadable', () => {
    const storage = fakeStorage();
    storage.setItem('stale-deployment-reload-guard', 'not-json{');
    expect(canReloadForStaleDeployment(storage, 123)).toBe(true);
    storage.setItem('stale-deployment-reload-guard', JSON.stringify({ at: 'nope' }));
    expect(canReloadForStaleDeployment(storage, 123)).toBe(true);
  });

  it('fails closed (no reload) when storage throws', () => {
    const storage: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(canReloadForStaleDeployment(storage)).toBe(false);
  });
});

describe('classifyStaleDeploymentError (global listener policy)', () => {
  // B1 regression: an automatic reload on a stale ACTION error would destroy
  // unsaved input in forms without pending-resend protection (CustomAgentForm
  // etc.). The global policy must never answer 'reload' for that class.
  it('never reloads for stale Server Action errors, even when the guard would allow it', () => {
    const storage = fakeStorage();
    expect(canReloadForStaleDeployment(storage, 1_000_000)).toBe(true);
    expect(classifyStaleDeploymentError(staleActionError(), storage, 1_000_000)).toBe('notify');
  });

  it('notifies (never silently drops) stale action errors repeated within the guard window', () => {
    const storage = fakeStorage();
    const t0 = 1_000_000;
    markStaleDeploymentReload(storage, t0);
    const later = t0 + FORM_RECOVERY_IN_FLIGHT_MS;
    expect(classifyStaleDeploymentError(staleActionError(), storage, later)).toBe('notify');
  });

  it('defers to a form-level recovery reload initiated moments ago', () => {
    const storage = fakeStorage();
    const t0 = 1_000_000;
    markStaleDeploymentReload(storage, t0);
    expect(classifyStaleDeploymentError(staleActionError(), storage, t0 + 100)).toBe('defer');
    expect(classifyStaleDeploymentError(chunkLoadError(), storage, t0 + 100)).toBe('defer');
  });

  it('reloads for chunk load errors when the guard allows it', () => {
    const storage = fakeStorage();
    expect(classifyStaleDeploymentError(chunkLoadError(), storage, 1_000_000)).toBe('reload');
  });

  it('falls back to notify when the guard blocks a chunk-error reload', () => {
    const storage = fakeStorage();
    const t0 = 1_000_000;
    markStaleDeploymentReload(storage, t0);
    const withinWindow = t0 + FORM_RECOVERY_IN_FLIGHT_MS + 1;
    expect(classifyStaleDeploymentError(chunkLoadError(), storage, withinWindow)).toBe('notify');
  });

  it('ignores ordinary errors (validation, permission, network)', () => {
    const storage = fakeStorage();
    expect(classifyStaleDeploymentError(new Error('Session not found'), storage, 1_000_000)).toBe('ignore');
    expect(classifyStaleDeploymentError(undefined, storage, 1_000_000)).toBe('ignore');
    expect(classifyStaleDeploymentError('boom', storage, 1_000_000)).toBe('ignore');
  });
});
