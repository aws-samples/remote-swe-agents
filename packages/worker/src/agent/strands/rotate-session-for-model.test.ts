import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rotateSessionForModel, type RotateSessionDeps, type RotateSessionInput } from './rotate-session-for-model';
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';

describe('rotateSessionForModel', () => {
  const baseHistory: MessageItem[] = [
    {
      PK: 'message-w-test',
      SK: '001',
      role: 'user',
      content: JSON.stringify([{ text: 'hello' }]),
      messageType: 'userMessage',
      tokenCount: 10,
    },
    {
      PK: 'message-w-test',
      SK: '002',
      role: 'assistant',
      content: JSON.stringify([{ text: 'hi' }]),
      messageType: 'assistant',
      tokenCount: 5,
    },
    {
      PK: 'message-w-test',
      SK: '003',
      role: 'user',
      content: JSON.stringify([{ text: 'current turn' }]),
      messageType: 'userMessage',
      tokenCount: 8,
    },
  ];

  const baseInput: RotateSessionInput = {
    workerId: 'w-test',
    currentSessionId: 'session-old',
    desiredModel: 'claude-sonnet-4.5',
    history: baseHistory,
    consumedTailCount: 1,
    cwd: '/tmp/test-cwd',
  };

  let deps: RotateSessionDeps;
  let synthesizeResult: { events: Array<unknown>; createdAt: string };

  beforeEach(() => {
    synthesizeResult = { events: [{ type: 'user' }], createdAt: '2026-01-01T00:00:00Z' };
    deps = {
      synthesize: vi.fn().mockResolvedValue(synthesizeResult),
      readModelId: vi.fn().mockImplementation((sessionId: string) => {
        if (sessionId === 'session-old') return 'claude-haiku-4.5';
        // For new sessions, return the desired model (simulating successful write)
        return 'claude-sonnet-4.5';
      }),
      sessionFilesExist: vi.fn().mockReturnValue(true),
      persistSessionId: vi.fn().mockResolvedValue(undefined),
      generateSessionId: vi.fn().mockReturnValue('session-new-uuid'),
    };
  });

  // Test ①: modelId match → no-op (rotation does not fire)
  it('returns no-op when live model matches desired model', async () => {
    // Set readModelId to return the desired model for the current session
    deps.readModelId = vi.fn().mockReturnValue('claude-sonnet-4.5');

    const result = await rotateSessionForModel(baseInput, deps);

    expect(result).toEqual({ ok: true, newSessionId: 'session-old', persisted: true });
    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(deps.persistSessionId).not.toHaveBeenCalled();
  });

  it('returns no-op when both live and desired are auto (undefined)', async () => {
    deps.readModelId = vi.fn().mockReturnValue(undefined);
    const input = { ...baseInput, desiredModel: undefined };

    const result = await rotateSessionForModel(input, deps);

    expect(result).toEqual({ ok: true, newSessionId: 'session-old', persisted: true });
    expect(deps.synthesize).not.toHaveBeenCalled();
  });

  // Test ②: mismatch → new session synthesize + persist switch
  it('rotates session when model mismatch (full happy path)', async () => {
    const result = await rotateSessionForModel(baseInput, deps);

    expect(result).toEqual({ ok: true, newSessionId: 'session-new-uuid', persisted: true });
    expect(deps.synthesize).toHaveBeenCalledWith({
      sessionId: 'session-new-uuid',
      cwd: '/tmp/test-cwd',
      items: baseHistory.slice(0, 2), // computeSynthPlan trims consumedTailCount=1
      modelId: 'claude-sonnet-4.5',
    });
    expect(deps.persistSessionId).toHaveBeenCalledWith('w-test', 'session-new-uuid');
  });

  it('passes the correct synthesised items from computeSynthPlan', async () => {
    const input = { ...baseInput, consumedTailCount: 2 };

    await rotateSessionForModel(input, deps);

    // consumedTailCount=2, so only first item is synthesised
    expect(deps.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [baseHistory[0]],
      })
    );
  });

  // Test ③: rotation failure → old session continue
  it('returns failure when synthesis throws (old session continues)', async () => {
    deps.synthesize = vi.fn().mockRejectedValue(new Error('disk full'));

    const result = await rotateSessionForModel(baseInput, deps);

    expect(result).toEqual({ ok: false, reason: 'disk full' });
    expect(deps.persistSessionId).not.toHaveBeenCalled();
  });

  it('returns ok with persisted=false when persist throws (switch still live)', async () => {
    deps.persistSessionId = vi.fn().mockRejectedValue(new Error('DDB timeout'));

    const result = await rotateSessionForModel(baseInput, deps);

    expect(result).toEqual({ ok: true, newSessionId: 'session-new-uuid', persisted: false });
  });

  // Test ④: fabrication guard fires
  it('returns failure when fabrication guard detects model mismatch (files vanished)', async () => {
    // Files exist for old session but NOT for the new one after synthesis
    deps.sessionFilesExist = vi.fn().mockImplementation((sessionId: string) => {
      return sessionId === 'session-old'; // new session files vanished
    });

    const result = await rotateSessionForModel(baseInput, deps);

    expect(result).toEqual({
      ok: false,
      reason: 'Session files disappeared after synthesis (filesystem race?)',
    });
    expect(deps.persistSessionId).not.toHaveBeenCalled();
  });

  it('returns failure when fabrication guard detects modelId mismatch in read-back', async () => {
    // readModelId returns wrong model for new session (simulating store-schema drift)
    deps.readModelId = vi.fn().mockImplementation((sessionId: string) => {
      if (sessionId === 'session-old') return 'claude-haiku-4.5';
      return 'claude-opus-4'; // Wrong! Expected claude-sonnet-4.5
    });

    const result = await rotateSessionForModel(baseInput, deps);

    expect(result).toEqual({
      ok: false,
      reason: 'kiro-cli ignored the rotated session files (store-schema drift?)',
    });
    expect(deps.persistSessionId).not.toHaveBeenCalled();
  });

  // Additional edge cases
  it('rejects invalid model IDs (defence-in-depth)', async () => {
    const input = { ...baseInput, desiredModel: '../../../etc/passwd' };

    const result = await rotateSessionForModel(input, deps);

    expect(result).toEqual({
      ok: false,
      reason: 'Refused to switch: invalid model id "../../../etc/passwd"',
    });
    expect(deps.synthesize).not.toHaveBeenCalled();
  });

  it('skips fabrication guard for empty-history rotation (lenient mode)', async () => {
    // Empty synthesis (no events) — fabrication guard is lenient
    synthesizeResult = { events: [], createdAt: '2026-01-01T00:00:00Z' };
    deps.synthesize = vi.fn().mockResolvedValue(synthesizeResult);
    // Even with all-auto readback, it should succeed
    deps.readModelId = vi.fn().mockImplementation((sessionId: string) => {
      if (sessionId === 'session-old') return 'claude-haiku-4.5';
      return undefined; // auto — doesn't matter for empty synth
    });

    const result = await rotateSessionForModel(baseInput, deps);

    expect(result).toEqual({ ok: true, newSessionId: 'session-new-uuid', persisted: true });
  });

  it('handles session with no existing files (new session, readModelId returns undefined)', async () => {
    deps.sessionFilesExist = vi.fn().mockImplementation((sessionId: string) => {
      if (sessionId === 'session-old') return false;
      return true; // new session files exist after synthesis
    });
    // No files for old session → liveModel = undefined (auto)
    deps.readModelId = vi.fn().mockImplementation((sessionId: string) => {
      if (sessionId === 'session-old') return undefined;
      return 'claude-sonnet-4.5';
    });

    // desiredModel = 'claude-sonnet-4.5', live = undefined (auto) → mismatch, rotate
    const result = await rotateSessionForModel(baseInput, deps);

    expect(result).toEqual({ ok: true, newSessionId: 'session-new-uuid', persisted: true });
  });
});
