import { describe, expect, test, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InferenceBackend, ToolEventSink, TurnContext, TurnResult } from '@remote-swe-agents/agent-core/lib';

const mocks = vi.hoisted(() => ({
  saveConversationHistory: vi.fn(async () => ({ SK: 'saved' })),
  sendSystemMessage: vi.fn(async () => undefined),
  updateSessionLastMessage: vi.fn(async () => undefined),
  sendWebappEvent: vi.fn(async () => undefined),
  sendAgentMessage: vi.fn(async () => undefined),
  getSession: vi.fn(async () => undefined as unknown),
  getCustomAgent: vi.fn(async () => undefined as unknown),
  getConversationHistory: vi.fn(
    async () =>
      ({ items: [], slackUserId: undefined }) as {
        items: unknown[];
        slackUserId: string | undefined;
      }
  ),
  repairDanglingToolUse: vi.fn(async () => [] as unknown[]),
  readMetadata: vi.fn(async () => undefined as unknown),
  writeMetadata: vi.fn(async () => undefined),
  readCommonPrompt: vi.fn(async () => undefined as unknown),
  refreshSession: vi.fn(async () => undefined),
  buildSessionHierarchyPrompt: vi.fn(async () => ''),
  incrementUnread: vi.fn(async () => undefined),
  sendPushNotificationToUser: vi.fn(async () => undefined),
  validateMermaidInText: vi.fn(async () => ({ valid: true, errors: [] as { chart: string; message: string }[] })),
  buildMermaidFeedback: vi.fn(() => '[SYSTEM] mermaid error feedback'),
  updateMessageType: vi.fn(async () => undefined),
  shouldSuppressUserDelivery: vi.fn(async () => false),
  recordUserDelivery: vi.fn(async () => undefined),
  shouldSuppressRehashOrSelfNarration: vi.fn(async () => false),
  shouldSuppressWakeupMonologueDelivery: vi.fn(async () => false),
  updateSession: vi.fn(async () => undefined),
  getPreferences: vi.fn(async () => ({ defaultAgentName: '' })),
  existsSync: vi.fn((_path: string) => true),
}));

vi.mock('@remote-swe-agents/agent-core/lib', async () => {
  const actual = await vi.importActual<typeof import('@remote-swe-agents/agent-core/lib')>(
    '@remote-swe-agents/agent-core/lib'
  );
  return {
    ...actual,
    saveConversationHistory: mocks.saveConversationHistory,
    sendSystemMessage: mocks.sendSystemMessage,
    updateSessionLastMessage: mocks.updateSessionLastMessage,
    sendWebappEvent: mocks.sendWebappEvent,
    sendAgentMessage: mocks.sendAgentMessage,
    getSession: mocks.getSession,
    getCustomAgent: mocks.getCustomAgent,
    getConversationHistory: mocks.getConversationHistory,
    repairDanglingToolUse: mocks.repairDanglingToolUse,
    readMetadata: mocks.readMetadata,
    writeMetadata: mocks.writeMetadata,
    readCommonPrompt: mocks.readCommonPrompt,
    incrementUnread: mocks.incrementUnread,
    sendPushNotificationToUser: mocks.sendPushNotificationToUser,
    validateMermaidInText: mocks.validateMermaidInText,
    buildMermaidFeedback: mocks.buildMermaidFeedback,
    updateMessageType: mocks.updateMessageType,
    shouldSuppressUserDelivery: mocks.shouldSuppressUserDelivery,
    recordUserDelivery: mocks.recordUserDelivery,
    shouldSuppressRehashOrSelfNarration: mocks.shouldSuppressRehashOrSelfNarration,
    shouldSuppressWakeupMonologueDelivery: mocks.shouldSuppressWakeupMonologueDelivery,
    updateSession: mocks.updateSession,
    getPreferences: mocks.getPreferences,
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: mocks.existsSync,
  };
});

vi.mock('../common/refresh-session', () => ({
  refreshSession: mocks.refreshSession,
}));

vi.mock('./persist-error-bubble', () => ({
  persistErrorBubble: vi.fn(async () => 'saved'),
}));

vi.mock('./lib/session-hierarchy', () => ({
  buildSessionHierarchyPrompt: mocks.buildSessionHierarchyPrompt,
}));

const { finalizeTurn, handleTurnError, runTurnWithBackend, buildTurnContext } = await import('./orchestrator');
const {
  isEndOfTurnPlaceholder,
  isInterruptPlaceholder,
  shouldSuppressFinalize,
  isScaffoldingArtifact,
  stripScaffoldingPrefix,
} = await import('./orchestrator');

const makeCtx = (overrides: Partial<TurnContext> = {}): TurnContext => ({
  workerId: 'w1',
  session: undefined,
  // Mirrors runtime: orchestrator always assigns `DefaultAgent` when no custom
  // agent is configured. DefaultAgent has `name: 'default agent'` which is
  // truthy — naive `ctx.customAgent?.name || ...` chains short-circuit on it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customAgent: { name: 'default agent' } as any,
  history: [],
  systemPrompt: '',
  cwd: '/tmp',
  userMessage: '',
  slackUserId: undefined,
  senderUserId: undefined,
  cancellationToken: { isCancelled: false, onCancel: () => () => {} },
  userSkills: [],
  ...overrides,
});

// User-facing dedup defaults to "not a duplicate" for every test. Set
// explicitly at the top level because `vi.clearAllMocks()` (used in the
// per-describe `beforeEach`) clears call data but NOT implementations set via
// `mockResolvedValue`, so a test that flips this to `true` would otherwise
// leak the truthy implementation into later describes.
beforeEach(() => {
  mocks.shouldSuppressUserDelivery.mockResolvedValue(false);
  mocks.shouldSuppressRehashOrSelfNarration.mockResolvedValue(false);
  mocks.shouldSuppressWakeupMonologueDelivery.mockResolvedValue(false);
});

describe('finalizeTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('persists assistant message when backend did not', async () => {
    const ctx = makeCtx();
    const result: TurnResult = {
      assistantMessage: { role: 'assistant', content: [{ text: 'hi' }] },
      alreadyPersisted: false,
      previewText: 'hi',
    };
    await finalizeTurn(ctx, result);
    expect(mocks.saveConversationHistory).toHaveBeenCalledTimes(1);
  });

  test('skips persistence when backend handled it', async () => {
    const ctx = makeCtx();
    const result: TurnResult = {
      assistantMessage: { role: 'assistant', content: [{ text: 'hi' }] },
      alreadyPersisted: true,
      previewText: 'hi',
    };
    await finalizeTurn(ctx, result);
    expect(mocks.saveConversationHistory).not.toHaveBeenCalled();
  });

  test('skipFinalize short-circuits everything', async () => {
    const ctx = makeCtx();
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [] },
      alreadyPersisted: true,
      previewText: 'unused',
      skipFinalize: true,
    });
    expect(mocks.saveConversationHistory).not.toHaveBeenCalled();
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.updateSessionLastMessage).not.toHaveBeenCalled();
  });

  test('updates last-message preview + fires webapp event', async () => {
    await finalizeTurn(makeCtx(), {
      assistantMessage: { role: 'assistant', content: [{ text: 'hello' }] },
      alreadyPersisted: true,
      previewText: 'hello',
    });
    // lastMessage update + lastMessageUpdate emit are now handled inside
    // sendSystemMessage (single-source). Orchestrator delegates via the call:
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', 'hello', true, false, undefined);
  });

  test('messageSK from result is passed through to sendSystemMessage (give-up / error persist parity)', async () => {
    await finalizeTurn(makeCtx(), {
      assistantMessage: { role: 'assistant', content: [{ text: 'An error occurred' }] },
      alreadyPersisted: true,
      previewText: 'An error occurred',
      messageSK: '00001787130000000',
    });
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', 'An error occurred', true, false, '00001787130000000');
  });

  test('Slack mention prefix applied when slackUserId present', async () => {
    await finalizeTurn(makeCtx({ slackUserId: 'U123' }), {
      assistantMessage: { role: 'assistant', content: [{ text: 'done' }] },
      alreadyPersisted: true,
      previewText: 'done',
    });
    // 4th arg is `skipWebappEmit`, defaults to `false` when the backend
    // did not set `webappMessageAlreadyEmitted`. See `TurnResult` in
    // agent-core/lib/inference/types.ts and `sendSystemMessage` in
    // agent-core/lib/messages.ts.
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', '<@U123> done', true, false, undefined);
  });

  test('webappMessageAlreadyEmitted=true forwards `true` as sendSystemMessage skipWebappEmit', async () => {
    // The Kiro tool-boundary text flush in `kiroAgentLoop` already emits
    // a `type:'message'` webapp event for the assistant text; if the
    // orchestrator re-emits via sendSystemMessage the user sees a
    // duplicate bubble. The flag in TurnResult propagates as the 4th
    // arg of sendSystemMessage, which gates only the webapp emit (Slack
    // is still delivered).
    await finalizeTurn(makeCtx({ slackUserId: 'U123' }), {
      assistantMessage: { role: 'assistant', content: [{ text: "I'll report." }] },
      alreadyPersisted: true,
      previewText: "I'll report.",
      webappMessageAlreadyEmitted: true,
    });
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', "<@U123> I'll report.", true, true, undefined);
    // The Slack/sidebar/parent/push channels MUST still run; the flag
    // only suppresses the webapp `type:'message'` emit inside
    // sendSystemMessage. lastMessage update + lastMessageUpdate emit are
    // now handled inside sendSystemMessage regardless of skipWebappEmit.
  });

  test('webappMessageAlreadyEmitted=true still redirects to parent on agentMessage history', async () => {
    // Critical regression guard for parent-triggered child agents whose
    // entire reply is "I'll do X" → tool → end-of-turn. The parent
    // redirect MUST run for those sessions; `webappMessageAlreadyEmitted`
    // gates ONLY the webapp emit.
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'agentMessage', SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'reply' }] },
      alreadyPersisted: true,
      previewText: 'reply',
      webappMessageAlreadyEmitted: true,
    });
    // Parent redirect fires.
    expect(mocks.sendAgentMessage).toHaveBeenCalled();
    // sendSystemMessage forwarded skipWebappEmit=true.
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', 'reply', true, true, undefined);
  });

  test('does NOT redirect to parent when last incoming was an acknowledge message', async () => {
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'agentMessage', isAcknowledge: true, SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'noted' }] },
      alreadyPersisted: true,
      previewText: 'noted',
    });
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });

  test('webappMessageAlreadyEmitted unset (undefined) defaults to false (backward compat)', async () => {
    // Legacy backends that do not opt into the new contract MUST keep
    // the existing webapp emit behaviour — the flag defaults to false
    // when the field is absent on TurnResult.
    await finalizeTurn(makeCtx(), {
      assistantMessage: { role: 'assistant', content: [{ text: 'hi' }] },
      alreadyPersisted: true,
      previewText: 'hi',
      // webappMessageAlreadyEmitted intentionally omitted
    });
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', 'hi', true, false, undefined);
  });

  test('webappMessageAlreadyEmitted=false explicit value behaves identically to unset', async () => {
    await finalizeTurn(makeCtx(), {
      assistantMessage: { role: 'assistant', content: [{ text: 'hi' }] },
      alreadyPersisted: true,
      previewText: 'hi',
      webappMessageAlreadyEmitted: false,
    });
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', 'hi', true, false, undefined);
  });

  test('redirects to parent when last incoming was agentMessage', async () => {
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'agentMessage', SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'reply' }] },
      alreadyPersisted: true,
      previewText: 'reply',
    });
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith({
      senderWorkerId: 'w1',
      targetSessionIds: ['p1'],
      message: 'reply',
    });
  });

  test('does NOT redirect to parent when last incoming was an acknowledge message', async () => {
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'agentMessage', isAcknowledge: true, SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'reply' }] },
      alreadyPersisted: true,
      previewText: 'reply',
    });
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });

  test('does not redirect when last incoming is a regular userMessage', async () => {
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'userMessage', SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'reply' }] },
      alreadyPersisted: true,
      previewText: 'reply',
    });
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });
});

describe('finalizeTurn — user-facing duplicate suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: not a duplicate (deliver normally).
    mocks.shouldSuppressUserDelivery.mockResolvedValue(false);
  });

  test('delivers + records when not a near-duplicate', async () => {
    mocks.shouldSuppressUserDelivery.mockResolvedValue(false);
    await finalizeTurn(makeCtx(), {
      assistantMessage: { role: 'assistant', content: [{ text: 'a real reply' }] },
      alreadyPersisted: true,
      previewText: 'a real reply',
    });
    expect(mocks.sendSystemMessage).toHaveBeenCalledTimes(1);
    expect(mocks.recordUserDelivery).toHaveBeenCalledWith('w1', 'a real reply');
  });

  test('suppresses Slack / preview / record when a near-duplicate (retrigger re-emit)', async () => {
    mocks.shouldSuppressUserDelivery.mockResolvedValue(true);
    await finalizeTurn(makeCtx(), {
      assistantMessage: { role: 'assistant', content: [{ text: 'duplicate reply' }] },
      alreadyPersisted: true,
      previewText: 'duplicate reply',
    });
    // User-facing side effects must NOT fire on a duplicate.
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.updateSessionLastMessage).not.toHaveBeenCalled();
    expect(mocks.recordUserDelivery).not.toHaveBeenCalled();
  });

  test('suppression does NOT bump unread / push', async () => {
    mocks.shouldSuppressUserDelivery.mockResolvedValue(true);
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', initiator: 'webapp#user-1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'userMessage', SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'duplicate reply' }] },
      alreadyPersisted: true,
      previewText: 'duplicate reply',
    });
    expect(mocks.incrementUnread).not.toHaveBeenCalled();
    expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
  });

  test('suppression still redirects to parent (agent path is independent)', async () => {
    mocks.shouldSuppressUserDelivery.mockResolvedValue(true);
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'agentMessage', SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'reply to parent' }] },
      alreadyPersisted: true,
      previewText: 'reply to parent',
    });
    // The user-facing Slack send is suppressed...
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    // ...but the parent redirect (agent-to-agent, separate recipient + own
    // dedup) must still happen.
    expect(mocks.sendAgentMessage).toHaveBeenCalledTimes(1);
  });

  test('fail-open: dedup check throwing still delivers (Slack + record fire)', async () => {
    // Integration-level guarantee: even if the dedup dependency rejects, the
    // orchestrator must still deliver the end-of-turn text (never drop it).
    mocks.shouldSuppressUserDelivery.mockRejectedValue(new Error('ddb down'));
    await finalizeTurn(makeCtx(), {
      assistantMessage: { role: 'assistant', content: [{ text: 'must still deliver' }] },
      alreadyPersisted: true,
      previewText: 'must still deliver',
    });
    expect(mocks.sendSystemMessage).toHaveBeenCalledTimes(1);
    expect(mocks.recordUserDelivery).toHaveBeenCalledWith('w1', 'must still deliver');
  });

  // ---------------------------------------------------------------------------
  // Deterministic self-narration / rehash / wake-up monologue suppression
  // ( / / ) wired at the finalize choke-point. The decision logic is
  // unit-tested as pure functions in agent-core/self-narration-filter.test.ts;
  // here we assert the orchestrator HONORS those decisions on the user-facing
  // side and gates the parent redirect correctly.
  // ---------------------------------------------------------------------------

  test('rehash / self-narration suppresses the user-facing delivery', async () => {
    mocks.shouldSuppressRehashOrSelfNarration.mockResolvedValue(true);
    await finalizeTurn(makeCtx(), {
      assistantMessage: {
        role: 'assistant',
        content: [{ text: 'Reported that the backend implementation is complete.' }],
      },
      alreadyPersisted: true,
      previewText: 'Reported that the backend implementation is complete.',
    });
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.updateSessionLastMessage).not.toHaveBeenCalled();
    expect(mocks.recordUserDelivery).not.toHaveBeenCalled();
  });

  test('self-narration also suppresses the parent redirect', async () => {
    mocks.shouldSuppressRehashOrSelfNarration.mockResolvedValue(true);
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'agentMessage', SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'I just reported the same status again.' }] },
      alreadyPersisted: true,
      previewText: 'I just reported the same status again.',
    });
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    // Unlike the auto-retrigger near-dup path, noise must NOT be relayed
    // to the parent (sendAgentMessage's near-dup dedup does not catch it).
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });

  test('no-information wake-up monologue suppresses the user-facing delivery', async () => {
    mocks.shouldSuppressWakeupMonologueDelivery.mockResolvedValue(true);
    const ctx = makeCtx({
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'eventTrigger', SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: {
        role: 'assistant',
        content: [{ text: 'Routine progress. No decision needed. Silent terminate.' }],
      },
      alreadyPersisted: true,
      previewText: 'Routine progress. No decision needed. Silent terminate.',
    });
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.updateSessionLastMessage).not.toHaveBeenCalled();
  });

  test(' wake-up monologue ALSO suppresses the parent redirect', async () => {
    // Driven specifically by the predicate (not the one) to pin
    // that a monologue on a parent-agentMessage-triggered turn is not relayed
    // back to the parent.
    mocks.shouldSuppressWakeupMonologueDelivery.mockResolvedValue(true);
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', messageType: 'agentMessage', SK: '1', content: '' } as any,
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: {
        role: 'assistant',
        content: [{ text: 'Already acknowledged; no new information. Silent terminate.' }],
      },
      alreadyPersisted: true,
      previewText: 'Already acknowledged; no new information. Silent terminate.',
    });
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });

  test('FALSE-POSITIVE GUARD: a genuine new report is delivered (both filters say false)', async () => {
    // Defaults: both new filters resolve false → message must go out everywhere.
    await finalizeTurn(makeCtx(), {
      assistantMessage: {
        role: 'assistant',
        content: [{ text: 'Deploy complete; verified the health check returned 200.' }],
      },
      alreadyPersisted: true,
      previewText: 'Deploy complete; verified the health check returned 200.',
    });
    expect(mocks.sendSystemMessage).toHaveBeenCalledTimes(1);
    expect(mocks.recordUserDelivery).toHaveBeenCalledWith(
      'w1',
      'Deploy complete; verified the health check returned 200.'
    );
  });

  test('FALSE-POSITIVE GUARD: new-filter throwing still delivers (fail-open)', async () => {
    mocks.shouldSuppressRehashOrSelfNarration.mockRejectedValue(new Error('ddb down'));
    mocks.shouldSuppressWakeupMonologueDelivery.mockRejectedValue(new Error('ddb down'));
    await finalizeTurn(makeCtx(), {
      assistantMessage: { role: 'assistant', content: [{ text: 'must still deliver despite filter error' }] },
      alreadyPersisted: true,
      previewText: 'must still deliver despite filter error',
    });
    expect(mocks.sendSystemMessage).toHaveBeenCalledTimes(1);
  });
});

describe('handleTurnError', () => {
  beforeEach(() => vi.clearAllMocks());

  test('persists error bubble and sends with SK when slackUserId is provided', async () => {
    const { persistErrorBubble } = await import('./persist-error-bubble');
    await handleTurnError('w1', 'U1', new Error('boom'));
    expect(persistErrorBubble).toHaveBeenCalledWith('w1', '<@U1> An error occurred: boom');
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', '<@U1> An error occurred: boom', true, false, 'saved');
  });

  test('persists and sends plain message when no slackUserId', async () => {
    const { persistErrorBubble } = await import('./persist-error-bubble');
    await handleTurnError('w1', undefined, new Error('boom'));
    expect(persistErrorBubble).toHaveBeenCalledWith('w1', 'An error occurred: boom');
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', 'An error occurred: boom', true, false, 'saved');
  });

  test('still sends message if persist fails (best-effort)', async () => {
    const { persistErrorBubble } = await import('./persist-error-bubble');
    (persistErrorBubble as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await handleTurnError('w1', 'U1', new Error('boom'));
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', '<@U1> An error occurred: boom', true, false, undefined);
  });
});

// -----------------------------------------------------------------------------
// Placeholder guard: isEndOfTurnPlaceholder / shouldSuppressFinalize plus the
// production-realistic finalizeTurn integration.
// -----------------------------------------------------------------------------

describe('isEndOfTurnPlaceholder', () => {
  test('undefined / empty / whitespace are placeholders', () => {
    expect(isEndOfTurnPlaceholder(undefined)).toBe(true);
    expect(isEndOfTurnPlaceholder('')).toBe(true);
    expect(isEndOfTurnPlaceholder('   ')).toBe(true);
    expect(isEndOfTurnPlaceholder('\n\n')).toBe(true);
    expect(isEndOfTurnPlaceholder('\t \n')).toBe(true);
  });

  test('1-3 dots are placeholders', () => {
    expect(isEndOfTurnPlaceholder('.')).toBe(true);
    expect(isEndOfTurnPlaceholder('..')).toBe(true);
    expect(isEndOfTurnPlaceholder('...')).toBe(true);
    expect(isEndOfTurnPlaceholder(' . ')).toBe(true);
  });

  test('single punctuation / symbol is a placeholder', () => {
    expect(isEndOfTurnPlaceholder(',')).toBe(true);
    expect(isEndOfTurnPlaceholder(';')).toBe(true);
    expect(isEndOfTurnPlaceholder('_')).toBe(true);
    expect(isEndOfTurnPlaceholder('-')).toBe(true);
  });

  test('short real words are NOT placeholders (narrow filter)', () => {
    expect(isEndOfTurnPlaceholder('ok')).toBe(false);
    expect(isEndOfTurnPlaceholder('done')).toBe(false);
    expect(isEndOfTurnPlaceholder('4')).toBe(false);
    expect(isEndOfTurnPlaceholder('Done.')).toBe(false);
    expect(isEndOfTurnPlaceholder('hello')).toBe(false);
  });

  test('4+ dots are NOT placeholders (out of scope)', () => {
    expect(isEndOfTurnPlaceholder('....')).toBe(false);
  });

  test('invisible unicode wrapping a placeholder is still a placeholder', () => {
    // These code points are NOT whitespace for String.prototype.trim but are
    // observed at stream chunk boundaries in some LLM outputs. Without the
    // explicit strip they would slip past as non-placeholder and the visible
    // "." would reach the user. See isEndOfTurnPlaceholder doc comment.
    expect(isEndOfTurnPlaceholder('\u200b.')).toBe(true); // zero-width space
    expect(isEndOfTurnPlaceholder('.\u200b')).toBe(true);
    expect(isEndOfTurnPlaceholder('\u200c.')).toBe(true); // zero-width non-joiner
    expect(isEndOfTurnPlaceholder('\u200d.')).toBe(true); // zero-width joiner
    expect(isEndOfTurnPlaceholder(' \u2060 . ')).toBe(true); // word joiner + spaces
    expect(isEndOfTurnPlaceholder('\ufeff.')).toBe(true); // BOM / ZWNBSP
    expect(isEndOfTurnPlaceholder('\u200b')).toBe(true); // ZWSP alone
    expect(isEndOfTurnPlaceholder('\t\u200b\n')).toBe(true); // tab + ZWSP + newline
  });

  test('short real words survive invisible unicode strip (still NOT placeholders)', () => {
    // Paranoia check: adding the strip must not turn legitimate replies
    // into placeholders. The strip only removes invisible code points; the
    // letter / digit content is untouched.
    expect(isEndOfTurnPlaceholder('ok')).toBe(false);
    expect(isEndOfTurnPlaceholder('\u200bok')).toBe(false);
    expect(isEndOfTurnPlaceholder('ok\u200b')).toBe(false);
    expect(isEndOfTurnPlaceholder('\ufeffdone.')).toBe(false);
    expect(isEndOfTurnPlaceholder('4\u200b')).toBe(false);
  });
});

describe('shouldSuppressFinalize', () => {
  // After the Reviewer feedback: this is a thin wrapper over
  // isEndOfTurnPlaceholder. The earlier tool-scan branch was removed because
  // `ctx.history` is the turn-start snapshot — the current turn's tool_use /
  // tool_result items are persisted inside the backend and never re-fetched
  // before finalizeTurn runs, so any "last tool was sendMessageToUser"
  // correlation was dead code in production. Keep the semantics simple and
  // honest: suppress the user-facing finalise only when the end-of-turn text
  // is a placeholder.

  test('empty / placeholder previewText -> suppress', () => {
    expect(shouldSuppressFinalize('')).toBe(true);
    expect(shouldSuppressFinalize('.')).toBe(true);
    expect(shouldSuppressFinalize('..')).toBe(true);
    expect(shouldSuppressFinalize('...')).toBe(true);
    expect(shouldSuppressFinalize('   ')).toBe(true);
    expect(shouldSuppressFinalize(',')).toBe(true);
  });

  test('meaningful previewText -> deliver', () => {
    expect(shouldSuppressFinalize('done')).toBe(false);
    expect(shouldSuppressFinalize('4')).toBe(false);
    expect(shouldSuppressFinalize('Done.')).toBe(false);
    expect(shouldSuppressFinalize('Summary: pushed to branch foo')).toBe(false);
  });

  test('ack word placeholders -> suppress via isAckWordPlaceholder', () => {
    expect(shouldSuppressFinalize('understood')).toBe(true);
    expect(shouldSuppressFinalize('Understood')).toBe(true);
    expect(shouldSuppressFinalize('understood.')).toBe(true);
    expect(shouldSuppressFinalize('noted')).toBe(true);
    expect(shouldSuppressFinalize('acknowledged')).toBe(true);
    expect(shouldSuppressFinalize('ok')).toBe(true);
    expect(shouldSuppressFinalize('got it')).toBe(true);
    expect(shouldSuppressFinalize('roger')).toBe(true);
    expect(shouldSuppressFinalize('copy')).toBe(true);
  });

  test('pure scaffolding artifact -> suppress via isScaffoldingArtifact', () => {
    // Entire message is a single <...> block with no user-visible remainder.
    expect(shouldSuppressFinalize('<continued in the following tool call>')).toBe(true);
    expect(shouldSuppressFinalize('<continue with the next tool call>')).toBe(true);
    expect(shouldSuppressFinalize('  <proceeding to next step>  ')).toBe(true);
  });

  test('scaffolding prefix + legitimate body -> deliver (the body is NOT a placeholder after strip)', () => {
    // Prefix-stripped content is a real message, so suppress returns false
    // and finalizeTurn delivers the remainder via deliveredText. This is
    // the common production shape observed in the regression E2E.
    expect(shouldSuppressFinalize('<continued in the following tool call>interim report to the user')).toBe(false);
    expect(shouldSuppressFinalize('<continue with more info>some message')).toBe(false);
  });

  test('scaffolding prefix with only a placeholder body -> suppress', () => {
    // After strip the remainder is ".", which the placeholder branch catches.
    expect(shouldSuppressFinalize('<continued in the following tool call> .')).toBe(true);
    expect(shouldSuppressFinalize('<continue> ')).toBe(true);
  });

  test('markup that is NOT scaffolding must pass through', () => {
    // Keyword gate prevents false-positive strip of legitimate HTML/XML.
    expect(shouldSuppressFinalize('<html><body>hello</body></html>')).toBe(false);
    expect(shouldSuppressFinalize('<div> tag is useful')).toBe(false);
    expect(shouldSuppressFinalize('<?xml version="1.0"?> metadata')).toBe(false);
    expect(shouldSuppressFinalize('Use <strong> for emphasis')).toBe(false);
  });

  test('kiro-cli interrupt placeholder -> suppress', () => {
    expect(shouldSuppressFinalize('Response was interrupted by the user')).toBe(true);
    expect(shouldSuppressFinalize('Response was interrupted by the user.')).toBe(true);
    expect(shouldSuppressFinalize('  Response was interrupted by the user  ')).toBe(true);
  });
});

describe('isScaffoldingArtifact', () => {
  test('whole-message single <...> block is an artifact', () => {
    expect(isScaffoldingArtifact('<continued in the following tool call>')).toBe(true);
    expect(isScaffoldingArtifact('<continue with more info>')).toBe(true);
    expect(isScaffoldingArtifact('<loading>')).toBe(true);
    expect(isScaffoldingArtifact('<n>')).toBe(true); // min length 1
    // leading / trailing whitespace + invisible unicode are tolerated
    expect(isScaffoldingArtifact('  <continue>  ')).toBe(true);
    expect(isScaffoldingArtifact('\u200b<continue>\u200b')).toBe(true);
  });

  test('messages with nested < >, newlines, or body are NOT artifacts', () => {
    // No inner < > (prevents matching nested HTML as a "whole artifact")
    expect(isScaffoldingArtifact('<html><body>x</body></html>')).toBe(false);
    // Newline inside the angle brackets disqualifies
    expect(isScaffoldingArtifact('<a\nb>')).toBe(false);
    // Body after `>` disqualifies (this is the stripScaffoldingPrefix case)
    expect(isScaffoldingArtifact('<continue>hello')).toBe(false);
    // Empty or undefined
    expect(isScaffoldingArtifact('')).toBe(false);
    expect(isScaffoldingArtifact(undefined)).toBe(false);
    // Missing closing `>`
    expect(isScaffoldingArtifact('<continue')).toBe(false);
    // Over-long inner (>100 chars) disqualifies — real documents shouldn't be suppressed
    expect(isScaffoldingArtifact('<' + 'a'.repeat(101) + '>')).toBe(false);
  });

  test('does not misidentify short real replies', () => {
    expect(isScaffoldingArtifact('ok')).toBe(false);
    expect(isScaffoldingArtifact('done.')).toBe(false);
    expect(isScaffoldingArtifact('4')).toBe(false);
  });
});

describe('stripScaffoldingPrefix', () => {
  test('strips a keyword-matching leading <...> block and delivers the remainder', () => {
    expect(stripScaffoldingPrefix('<continued in the following tool call>interim report to the user')).toBe(
      'interim report to the user'
    );
    expect(stripScaffoldingPrefix('<continue with more info>some message')).toBe('some message');
    expect(stripScaffoldingPrefix('<next step> hello')).toBe('hello');
    // Trailing whitespace / punctuation after the block is preserved on the
    // body (only leading whitespace is trimmed)
    expect(stripScaffoldingPrefix('<continued> Summary: done.')).toBe('Summary: done.');
    // CJK immediately after `>` is a valid boundary (no required whitespace)
    expect(stripScaffoldingPrefix('<continued>report to the user')).toBe('report to the user');
  });

  test('does NOT strip legitimate markup (keyword gate)', () => {
    // No scaffolding keyword in the inner text → pass-through
    expect(stripScaffoldingPrefix('<html><body>hello</body></html>')).toBe('<html><body>hello</body></html>');
    expect(stripScaffoldingPrefix('<div> tag is useful')).toBe('<div> tag is useful');
    expect(stripScaffoldingPrefix('<strong>emphasis</strong>')).toBe('<strong>emphasis</strong>');
    // ?xml prolog: "?xml version" has no scaffolding keyword
    expect(stripScaffoldingPrefix('<?xml version="1.0"?> metadata')).toBe('<?xml version="1.0"?> metadata');
  });

  test('no leading <...> → pass-through untouched', () => {
    expect(stripScaffoldingPrefix('hello world')).toBe('hello world');
    expect(stripScaffoldingPrefix('')).toBe('');
    expect(stripScaffoldingPrefix('Summary: Use <continue> somewhere mid-text')).toBe(
      'Summary: Use <continue> somewhere mid-text'
    );
    // Block exists but not at position 0
    expect(stripScaffoldingPrefix(' <continue>text')).toBe(' <continue>text');
  });

  test('keyword gate is the only safety: non-keyword inner is always pass-through', () => {
    // With the boundary assertion removed from the regex, the sole
    // false-positive mitigation is the keyword list. Re-assert the
    // negative cases at the boundary positions the old regex used to
    // defend: ASCII letter/digit immediately after `>` with a
    // non-keyword inner must still pass through.
    expect(stripScaffoldingPrefix('<div>42text')).toBe('<div>42text');
    expect(stripScaffoldingPrefix('<span>text')).toBe('<span>text');
    // ASCII letter/digit immediately after `>` with a KEYWORD inner is
    // now stripped — the keyword match is strong enough signal that we
    // do not require a punctuation / whitespace boundary.
    expect(stripScaffoldingPrefix('<continue>42text')).toBe('42text');
    expect(stripScaffoldingPrefix('<continue>some message')).toBe('some message');
  });
});

describe('finalizeTurn placeholder guard (production-realistic)', () => {
  // These tests exercise the actual code paths that run in production, given
  // the hard fact that ctx.history is a turn-start snapshot. The backend may
  // have saved tool_use / tool_result items during its runTurn, but those
  // items are NOT visible to finalizeTurn through ctx.history. So the only
  // signal available is `result.previewText`.

  beforeEach(() => vi.clearAllMocks());

  type HistoryItem = import('@remote-swe-agents/agent-core/schema').MessageItem;

  const userItem = (sk: string, text = 'hi'): HistoryItem => ({
    PK: 'message-w1',
    SK: sk,
    role: 'user',
    messageType: 'userMessage',
    content: JSON.stringify([{ text }]),
    tokenCount: 0,
  });

  test('history=[userMessage] + placeholder "." -> suppress everything', async () => {
    const ctx = makeCtx({ history: [userItem('001', 'hello')] });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: '.' }] },
      alreadyPersisted: true,
      previewText: '.',
    });
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.updateSessionLastMessage).not.toHaveBeenCalled();
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });

  test('history=[userMessage] + empty previewText -> suppress everything', async () => {
    const ctx = makeCtx({ history: [userItem('001')] });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: '' }] },
      alreadyPersisted: true,
      previewText: '',
    });
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
    expect(mocks.updateSessionLastMessage).not.toHaveBeenCalled();
  });

  test('history=[userMessage] + real summary -> full finalize (Slack + preview)', async () => {
    const ctx = makeCtx({ history: [userItem('001')] });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'Done.' }] },
      alreadyPersisted: true,
      previewText: 'Done.',
    });
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', 'Done.', true, false, undefined);
  });

  test('history=[userMessage] + short real reply "ok" -> suppress (ack word placeholder)', async () => {
    const ctx = makeCtx({ history: [userItem('001')] });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'ok' }] },
      alreadyPersisted: true,
      previewText: 'ok',
    });
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
  });

  test('assistant message is still persisted even when finalize is suppressed', async () => {
    const ctx = makeCtx({ history: [userItem('001')] });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: '' }] },
      alreadyPersisted: false,
      previewText: '',
    });
    expect(mocks.saveConversationHistory).toHaveBeenCalledTimes(1);
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
  });

  test('agentMessage-triggered turn + real summary -> parent redirect happens', async () => {
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [{ ...userItem('001', 'from parent'), messageType: 'agentMessage' }],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: 'Report: done.' }] },
      alreadyPersisted: true,
      previewText: 'Report: done.',
    });
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith({
      senderWorkerId: 'w1',
      targetSessionIds: ['p1'],
      message: 'Report: done.',
    });
  });

  test('agentMessage-triggered turn + placeholder -> no parent redirect (guard short-circuits)', async () => {
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [{ ...userItem('001'), messageType: 'agentMessage' }],
    });
    await finalizeTurn(ctx, {
      assistantMessage: { role: 'assistant', content: [{ text: '.' }] },
      alreadyPersisted: true,
      previewText: '.',
    });
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
  });
});

describe('finalizeTurn: parent double-delivery (expected behaviour, not enforced)', () => {
  // This test documents the behaviour the reviewer asked us to pin down
  // explicitly: if the model violates the system-prompt rule and BOTH
  // (a) invokes sendMessageToAgent(parent, "X") during the turn, AND
  // (b) emits "X" as the end-of-turn text,
  // then the parent WILL receive the message twice — once from the tool
  // handler (which runs inline during the turn), once from the orchestrator's
  // agentMessage-triggered redirect. The code does NOT dedupe this; it is
  // the model's responsibility (per the system prompt) not to echo its own
  // tool call as final text. We pin the behaviour here so any future
  // dedup work starts from an explicit baseline.
  beforeEach(() => vi.clearAllMocks());

  test('end-of-turn text is redirected even when a tool call would have been a duplicate', async () => {
    // We cannot easily assert the in-turn tool-handler call from this test
    // (it runs inside backend.runTurn), so we assert the orchestrator side:
    // when the incoming was an agentMessage and the final text is real,
    // sendAgentMessage IS called unconditionally. Combined with the fact
    // that the sendMessageToAgent tool handler already delivered to the
    // parent during the turn, this demonstrates the duplicate path.
    const ctx = makeCtx({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { workerId: 'w1', parentSessionId: 'p1' } as any,
      history: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          ...({ PK: 'message-w1', SK: '001', role: 'user', tokenCount: 0, content: '' } as any),
          messageType: 'agentMessage',
        },
      ],
    });
    await finalizeTurn(ctx, {
      assistantMessage: {
        role: 'assistant',
        content: [{ text: 'Same text the model also sent via sendMessageToAgent' }],
      },
      alreadyPersisted: true,
      previewText: 'Same text the model also sent via sendMessageToAgent',
    });
    expect(mocks.sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderWorkerId: 'w1',
        targetSessionIds: ['p1'],
        message: 'Same text the model also sent via sendMessageToAgent',
      })
    );
  });
});

describe('orchestrator + backend wiring smoke', () => {
  test('TurnResult contract: skipFinalize path is idempotent', async () => {
    const backend: InferenceBackend = {
      kind: 'bedrock',
      async runTurn(_ctx: TurnContext, _sink: ToolEventSink): Promise<TurnResult> {
        return {
          assistantMessage: { role: 'assistant', content: [] },
          alreadyPersisted: true,
          previewText: '',
          skipFinalize: true,
        };
      },
    };
    const result = await backend.runTurn(makeCtx(), {} as ToolEventSink);
    expect(result.skipFinalize).toBe(true);
  });
});

describe('runTurnWithBackend (end-to-end)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reasonable default: a userMessage turn with no parent and no prior tools.
    mocks.getConversationHistory.mockResolvedValue({
      items: [
        {
          PK: 'message-w1',
          SK: '000000000001000',
          role: 'user',
          messageType: 'userMessage',
          content: JSON.stringify([{ text: 'hello' }]),
          tokenCount: 0,
        },
      ],
      slackUserId: 'U1',
    });
    mocks.repairDanglingToolUse.mockResolvedValue([]);
    mocks.getSession.mockResolvedValue(undefined);
    mocks.getCustomAgent.mockResolvedValue(undefined);
    mocks.readMetadata.mockResolvedValue(undefined);
    mocks.readCommonPrompt.mockResolvedValue(undefined);
  });

  const cancellable = { isCancelled: false };

  const makeBackend = (impl: Partial<InferenceBackend>): InferenceBackend => ({
    kind: 'bedrock',
    runTurn:
      impl.runTurn ??
      (async () => ({
        assistantMessage: { role: 'assistant', content: [{ text: 'ok' }] },
        alreadyPersisted: false,
        previewText: 'ok',
      })),
    dispose: impl.dispose,
  });

  test('calls backend.runTurn with a built context', async () => {
    const runTurn: InferenceBackend['runTurn'] = vi.fn(async (_ctx, _sink) => ({
      assistantMessage: { role: 'assistant' as const, content: [{ text: 'done' }] },
      alreadyPersisted: false,
      previewText: 'done',
    }));
    const backend = makeBackend({ runTurn });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(runTurn).toHaveBeenCalledTimes(1);
    const calls = (runTurn as unknown as { mock: { calls: [TurnContext, ToolEventSink][] } }).mock.calls;
    const ctx = calls[0]![0];
    expect(ctx.workerId).toBe('w1');
    expect(ctx.userMessage).toBe('hello');
    expect(ctx.slackUserId).toBe('U1');
    // finalizeTurn persisted the assistant text (alreadyPersisted: false).
    expect(mocks.saveConversationHistory).toHaveBeenCalledTimes(1);
    // And sent the Slack message with mention.
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', '<@U1> done', true, false, 'saved');
  });

  test('backend throwing routes through handleTurnError', async () => {
    const backend = makeBackend({
      runTurn: async () => {
        throw new Error('backend exploded');
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(mocks.sendSystemMessage).toHaveBeenCalledWith(
      'w1',
      '<@U1> An error occurred: backend exploded',
      true,
      false,
      'saved'
    );
    // Error message is persisted via persistErrorBubble helper.
    const { persistErrorBubble } = await import('./persist-error-bubble');
    expect(persistErrorBubble).toHaveBeenCalledWith('w1', '<@U1> An error occurred: backend exploded');
  });

  test('cancellation between runTurn and finalizeTurn skips finalization', async () => {
    const token = { isCancelled: false };
    const backend = makeBackend({
      runTurn: async () => {
        // Simulate the cancel token flipping right before we return.
        token.isCancelled = true;
        return {
          assistantMessage: { role: 'assistant', content: [{ text: 'partial' }] },
          alreadyPersisted: false,
          previewText: 'partial',
        };
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', token as any, backend, undefined);

    expect(mocks.saveConversationHistory).not.toHaveBeenCalled();
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
  });

  test('empty history short-circuits without invoking the backend', async () => {
    // fetchHistoryWithReplicationRetry returns an empty list → no last item → bail out.
    mocks.getConversationHistory.mockResolvedValue({ items: [], slackUserId: undefined });
    const runTurn = vi.fn();
    const backend = makeBackend({ runTurn: runTurn as unknown as InferenceBackend['runTurn'] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(runTurn).not.toHaveBeenCalled();
    expect(mocks.saveConversationHistory).not.toHaveBeenCalled();
    expect(mocks.sendSystemMessage).not.toHaveBeenCalled();
  });

  test('buildTurnContext error is reported via handleTurnError', async () => {
    mocks.getConversationHistory.mockImplementation(async () => {
      throw new Error('ddb down');
    });
    const runTurn = vi.fn();
    const backend = makeBackend({ runTurn: runTurn as unknown as InferenceBackend['runTurn'] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(runTurn).not.toHaveBeenCalled();
    // handleTurnError is called without slackUserId because ctx was never built.
    expect(mocks.sendSystemMessage).toHaveBeenCalledWith('w1', 'An error occurred: ddb down', true, false, 'saved');
  });
});

describe('runTurnWithBackend retrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConversationHistory.mockResolvedValue({
      items: [
        {
          PK: 'message-w1',
          SK: '000000000001000',
          role: 'user',
          messageType: 'userMessage',
          content: JSON.stringify([{ text: 'hello' }]),
          tokenCount: 0,
        },
      ],
      slackUserId: 'U1',
    });
    mocks.repairDanglingToolUse.mockResolvedValue([]);
    mocks.getSession.mockResolvedValue(undefined);
    mocks.getCustomAgent.mockResolvedValue(undefined);
    mocks.readMetadata.mockResolvedValue(undefined);
    mocks.readCommonPrompt.mockResolvedValue(undefined);
  });

  const cancellable = { isCancelled: false };

  const makeBackend = (impl: Partial<InferenceBackend>): InferenceBackend => ({
    kind: 'bedrock',
    runTurn:
      impl.runTurn ??
      (async () => ({
        assistantMessage: { role: 'assistant', content: [{ text: 'ok' }] },
        alreadyPersisted: false,
        previewText: 'ok',
      })),
    dispose: impl.dispose,
  });

  test('retrigger=true causes a delayed recursive call', async () => {
    let callCount = 0;
    const runTurn: InferenceBackend['runTurn'] = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          assistantMessage: { role: 'assistant' as const, content: [{ text: 'error' }] },
          alreadyPersisted: true,
          previewText: 'error',
          retrigger: true,
          retriggerDelayMs: 10, // short delay for test
        };
      }
      return {
        assistantMessage: { role: 'assistant' as const, content: [{ text: 'recovered' }] },
        alreadyPersisted: false,
        previewText: 'recovered',
      };
    });
    const backend = makeBackend({ runTurn });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(runTurn).toHaveBeenCalledTimes(2);
    // systemRetrigger message should have been saved
    expect(mocks.saveConversationHistory).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ role: 'user' }),
      0,
      'systemRetrigger'
    );
  });

  test('retrigger is skipped when cancellation is requested', async () => {
    const token = { isCancelled: false };
    const runTurn: InferenceBackend['runTurn'] = vi.fn(async () => {
      token.isCancelled = true; // simulate cancellation during turn
      return {
        assistantMessage: { role: 'assistant' as const, content: [{ text: 'error' }] },
        alreadyPersisted: true,
        previewText: 'error',
        retrigger: true,
        retriggerDelayMs: 10,
      };
    });
    const backend = makeBackend({ runTurn });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', token as any, backend, undefined);

    // Should NOT recurse because cancellation was set
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(mocks.saveConversationHistory).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'user' }),
      0,
      'systemRetrigger'
    );
  });

  test('retrigger=false does not recurse', async () => {
    const runTurn: InferenceBackend['runTurn'] = vi.fn(async () => ({
      assistantMessage: { role: 'assistant' as const, content: [{ text: 'done' }] },
      alreadyPersisted: false,
      previewText: 'done',
    }));
    const backend = makeBackend({ runTurn });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  test('retrigger message includes <command> hint to prevent re-sending', async () => {
    let callCount = 0;
    const runTurn: InferenceBackend['runTurn'] = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          assistantMessage: { role: 'assistant' as const, content: [{ text: 'first' }] },
          alreadyPersisted: true,
          previewText: 'first',
          retrigger: true,
          retriggerDelayMs: 10,
        };
      }
      return {
        assistantMessage: { role: 'assistant' as const, content: [{ text: 'second' }] },
        alreadyPersisted: false,
        previewText: 'second',
      };
    });
    const backend = makeBackend({ runTurn });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    const retriggerCall = mocks.saveConversationHistory.mock.calls.find((c: any[]) => c[3] === 'systemRetrigger') as
      | any[]
      | undefined;
    expect(retriggerCall).toBeDefined();
    const retriggerContent = retriggerCall![1].content[0].text;
    expect(retriggerContent).toContain('<command>');
    expect(retriggerContent).toContain('Do NOT re-send');
    expect(retriggerContent).toContain('silent');
  });
});

describe('runTurnWithBackend context-usage (design B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConversationHistory.mockResolvedValue({
      items: [
        {
          PK: 'message-w1',
          SK: '000000000001000',
          role: 'user',
          messageType: 'userMessage',
          content: JSON.stringify([{ text: 'hello' }]),
          tokenCount: 0,
        },
      ],
      slackUserId: 'U1',
    });
    mocks.repairDanglingToolUse.mockResolvedValue([]);
    mocks.getSession.mockResolvedValue(undefined);
    mocks.getCustomAgent.mockResolvedValue(undefined);
    mocks.readMetadata.mockResolvedValue(undefined);
    mocks.readCommonPrompt.mockResolvedValue(undefined);
  });

  const cancellable = { isCancelled: false };
  const makeBackend = (impl: Partial<InferenceBackend>): InferenceBackend => ({
    kind: 'bedrock',
    runTurn:
      impl.runTurn ??
      (async () => ({
        assistantMessage: { role: 'assistant', content: [{ text: 'ok' }] },
        alreadyPersisted: false,
        previewText: 'ok',
      })),
    dispose: impl.dispose,
  });

  test('emits a [context-usage] observability log when the percentage is known', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const backend = makeBackend({
        runTurn: async () => ({
          assistantMessage: { role: 'assistant' as const, content: [{ text: 'ok' }] },
          alreadyPersisted: false,
          previewText: 'ok',
          contextUsagePercentage: 42.349,
        }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runTurnWithBackend('w1', cancellable as any, backend, undefined);
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('[context-usage]'));
      expect(line).toBeDefined();
      expect(line).toContain('workerId=w1');
      expect(line).toContain('contextUsagePercentage=42.35');
    } finally {
      logSpy.mockRestore();
    }
  });

  test('does NOT emit a [context-usage] log when the percentage is unknown', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const backend = makeBackend({
        runTurn: async () => ({
          assistantMessage: { role: 'assistant' as const, content: [{ text: 'ok' }] },
          alreadyPersisted: false,
          previewText: 'ok',
          // contextUsagePercentage intentionally omitted
        }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await runTurnWithBackend('w1', cancellable as any, backend, undefined);
      const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('[context-usage]'));
      expect(line).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  test('persists lastContextUsagePercentage for the next turn when known', async () => {
    const backend = makeBackend({
      runTurn: async () => ({
        assistantMessage: { role: 'assistant' as const, content: [{ text: 'ok' }] },
        alreadyPersisted: false,
        previewText: 'ok',
        contextUsagePercentage: 63.2,
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);
    expect(mocks.updateSession).toHaveBeenCalledWith('w1', { lastContextUsagePercentage: 63.2 });
  });

  test('does not persist lastContextUsagePercentage when unknown', async () => {
    const backend = makeBackend({
      runTurn: async () => ({
        assistantMessage: { role: 'assistant' as const, content: [{ text: 'ok' }] },
        alreadyPersisted: false,
        previewText: 'ok',
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);
    expect(mocks.updateSession).not.toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ lastContextUsagePercentage: expect.anything() })
    );
  });

  test('design B: backend receives a context-usage environment block built from session.lastContextUsagePercentage', async () => {
    mocks.getSession.mockResolvedValue({ workerId: 'w1', lastContextUsagePercentage: 71 } as any);
    let seenEnv: string | undefined = 'UNSET';
    const backend = makeBackend({
      runTurn: async (ctx) => {
        seenEnv = ctx.environmentBlock;
        return {
          assistantMessage: { role: 'assistant' as const, content: [{ text: 'ok' }] },
          alreadyPersisted: false,
          previewText: 'ok',
        };
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);
    expect(seenEnv).toContain('## Context Window Usage');
    expect(seenEnv).toContain('~71%');
  });

  test('design B: no environment block when the session has no prior usage', async () => {
    mocks.getSession.mockResolvedValue({ workerId: 'w1' } as any);
    let seenEnv: string | undefined = 'UNSET';
    const backend = makeBackend({
      runTurn: async (ctx) => {
        seenEnv = ctx.environmentBlock;
        return {
          assistantMessage: { role: 'assistant' as const, content: [{ text: 'ok' }] },
          alreadyPersisted: false,
          previewText: 'ok',
        };
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);
    expect(seenEnv).toBeUndefined();
  });
});

describe('finalizeTurn: incrementUnread + push notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const result: TurnResult = {
    assistantMessage: { role: 'assistant', content: [{ text: 'hello' }] },
    alreadyPersisted: true,
    previewText: 'hello',
  };

  test('webapp# initiator + no parent + lastIncoming=userMessage → fires incrementUnread and push', async () => {
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1', title: 'Test' } as any,
      history: [{ role: 'user', messageType: 'userMessage' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.incrementUnread).toHaveBeenCalledWith('user123', 'w1');
    expect(mocks.sendPushNotificationToUser).toHaveBeenCalledWith('user123', {
      title: 'Agent',
      body: 'Test\nhello',
      url: '/sessions/w1',
      workerId: 'w1',
    });
  });

  test('REGRESSION repro: webapp# top-level + lastIncoming=agentMessage → does NOT fire', async () => {
    // This is the bug introduced by a745803: a top-level session that wakes up
    // because a child sent it `[Child error]` / `[Child sleeping]` (an
    // agentMessage) used to bump the user's unread + push because the
    // redirect check was gated on parentSessionId being set. The new hard
    // guard `messageType === 'userMessage'` skips this path correctly.
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1', title: 'Test' } as any,
      history: [{ role: 'user', messageType: 'agentMessage' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.incrementUnread).not.toHaveBeenCalled();
    expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
  });

  test('webapp# top-level + lastIncoming=eventTrigger → does NOT fire', async () => {
    // Event-trigger-driven turns are not user-initiated, so they do not warrant
    // a user-facing push. This matches the pre-fix end-of-turn behaviour for
    // event triggers (no spec change).
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1' } as any,
      history: [{ role: 'user', messageType: 'eventTrigger' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.incrementUnread).not.toHaveBeenCalled();
    expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
  });

  test('webapp# top-level + empty history → does NOT fire', async () => {
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1' } as any,
      history: [],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.incrementUnread).not.toHaveBeenCalled();
    expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
  });

  test('webapp# child + lastIncoming=agentMessage → does NOT fire (parent redirect)', async () => {
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1', parentSessionId: 'parent1' } as any,
      history: [{ role: 'user', messageType: 'agentMessage' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.incrementUnread).not.toHaveBeenCalled();
    expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
  });

  test('webapp# child + lastIncoming=userMessage → fires (child opened directly by user)', async () => {
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1', parentSessionId: 'parent1' } as any,
      history: [{ role: 'user', messageType: 'userMessage' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.incrementUnread).toHaveBeenCalledWith('user123', 'w1');
    expect(mocks.sendPushNotificationToUser).toHaveBeenCalled();
  });

  test('slack# initiator → does NOT fire', async () => {
    const ctx = makeCtx({
      session: { initiator: 'slack#U999', workerId: 'w1' } as any,
      history: [{ role: 'user', messageType: 'userMessage' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.incrementUnread).not.toHaveBeenCalled();
    expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
  });

  test('placeholder text → does NOT fire (suppressed early)', async () => {
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1' } as any,
      history: [{ role: 'user', messageType: 'userMessage' }] as any[],
    });
    await finalizeTurn(ctx, { ...result, previewText: '.' });
    expect(mocks.incrementUnread).not.toHaveBeenCalled();
    expect(mocks.sendPushNotificationToUser).not.toHaveBeenCalled();
  });

  test('no customAgentId + agentName set → title uses session.agentName (not DefaultAgent.name)', async () => {
    const ctx = makeCtx({
      session: {
        initiator: 'webapp#user123',
        workerId: 'w1',
        title: 'My Session',
        agentName: 'Backend Dev (notification improvements)',
      } as any,
      history: [{ role: 'user', messageType: 'userMessage' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.sendPushNotificationToUser).toHaveBeenCalledWith('user123', {
      title: 'Backend Dev (notification improvements)',
      body: 'My Session\nhello',
      url: '/sessions/w1',
      workerId: 'w1',
    });
  });

  test('customAgentId set + customAgent.name → title uses custom agent name', async () => {
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1', title: 'Test', customAgentId: 'agent-1' } as any,
      customAgent: { name: 'Assistant' } as any,
      history: [{ role: 'user', messageType: 'userMessage' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.sendPushNotificationToUser).toHaveBeenCalledWith('user123', {
      title: 'Assistant',
      body: 'Test\nhello',
      url: '/sessions/w1',
      workerId: 'w1',
    });
  });

  test('no customAgentId + no agentName → title falls back to "Agent"', async () => {
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1', title: 'Test' } as any,
      history: [{ role: 'user', messageType: 'userMessage' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.sendPushNotificationToUser).toHaveBeenCalledWith('user123', {
      title: 'Agent',
      body: 'Test\nhello',
      url: '/sessions/w1',
      workerId: 'w1',
    });
  });

  test('no customAgentId + no agentName + defaultAgentName set → title uses defaultAgentName', async () => {
    mocks.getPreferences.mockResolvedValueOnce({ defaultAgentName: 'NekoHelper' });
    const ctx = makeCtx({
      session: { initiator: 'webapp#user123', workerId: 'w1', title: 'Test' } as any,
      history: [{ role: 'user', messageType: 'userMessage' }] as any[],
    });
    await finalizeTurn(ctx, result);
    expect(mocks.sendPushNotificationToUser).toHaveBeenCalledWith('user123', {
      title: 'NekoHelper',
      body: 'Test\nhello',
      url: '/sessions/w1',
      workerId: 'w1',
    });
  });
});

// -----------------------------------------------------------------------------
// Mermaid self-heal: validation + retry in runTurnWithBackend
// -----------------------------------------------------------------------------

describe('runTurnWithBackend — mermaid self-heal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: history has a user message so buildTurnContext succeeds
    mocks.getConversationHistory.mockResolvedValue({
      items: [
        {
          PK: 'message-w1',
          SK: '000000000000001',
          role: 'user',
          content: JSON.stringify([{ text: 'draw a diagram' }]),
          tokenCount: 10,
          messageType: 'userMessage',
        },
      ],
      slackUserId: undefined,
    });
    mocks.getSession.mockResolvedValue({ workerId: 'w1' });
    mocks.getCustomAgent.mockResolvedValue(undefined);
    mocks.readMetadata.mockResolvedValue(undefined);
    mocks.readCommonPrompt.mockResolvedValue(undefined);
    mocks.repairDanglingToolUse.mockResolvedValue([]);
    mocks.validateMermaidInText.mockResolvedValue({ valid: true, errors: [] });
  });

  test('passes through when mermaid is valid', async () => {
    const backend: InferenceBackend = {
      kind: 'bedrock',
      runTurn: vi.fn(async () => ({
        assistantMessage: { role: 'assistant' as const, content: [{ text: 'graph TD\n  A-->B' }] },
        alreadyPersisted: true,
        previewText: '```mermaid\ngraph TD\n  A-->B\n```',
      })),
    };
    const cancel = { isCancelled: false, onCancel: () => () => {} };
    await runTurnWithBackend('w1', cancel as any, backend);
    expect(backend.runTurn).toHaveBeenCalledTimes(1);
    expect(mocks.updateMessageType).not.toHaveBeenCalled();
  });

  test('retries once on invalid mermaid then succeeds', async () => {
    mocks.validateMermaidInText
      .mockResolvedValueOnce({ valid: false, errors: [{ chart: 'bad', message: 'parse error' }] })
      .mockResolvedValueOnce({ valid: true, errors: [] });

    // After rejection, getConversationHistory is called again for rebuild
    mocks.getConversationHistory
      .mockResolvedValueOnce({
        items: [
          {
            PK: 'message-w1',
            SK: '000000000000001',
            role: 'user',
            content: JSON.stringify([{ text: 'draw' }]),
            tokenCount: 10,
            messageType: 'userMessage',
          },
        ],
        slackUserId: undefined,
      })
      // Called by the retry to find the persisted assistant message
      .mockResolvedValueOnce({
        items: [
          {
            PK: 'message-w1',
            SK: '000000000000001',
            role: 'user',
            content: JSON.stringify([{ text: 'draw' }]),
            tokenCount: 10,
            messageType: 'userMessage',
          },
          {
            PK: 'message-w1',
            SK: '000000000000002',
            role: 'assistant',
            content: JSON.stringify([{ text: 'broken' }]),
            tokenCount: 5,
            messageType: 'assistant',
          },
        ],
        slackUserId: undefined,
      })
      // Called by buildTurnContext on retry
      .mockResolvedValueOnce({
        items: [
          {
            PK: 'message-w1',
            SK: '000000000000001',
            role: 'user',
            content: JSON.stringify([{ text: 'draw' }]),
            tokenCount: 10,
            messageType: 'userMessage',
          },
          {
            PK: 'message-w1',
            SK: '000000000000003',
            role: 'user',
            content: JSON.stringify([{ text: 'feedback' }]),
            tokenCount: 5,
            messageType: 'mermaidFeedback',
          },
        ],
        slackUserId: undefined,
      });

    const backend: InferenceBackend = {
      kind: 'bedrock',
      runTurn: vi.fn(async () => ({
        assistantMessage: { role: 'assistant' as const, content: [{ text: 'fixed' }] },
        alreadyPersisted: true,
        previewText: '```mermaid\ngraph TD\n  A-->B\n```',
      })),
    };
    const cancel = { isCancelled: false, onCancel: () => () => {} };
    await runTurnWithBackend('w1', cancel as any, backend);

    expect(backend.runTurn).toHaveBeenCalledTimes(2);
    expect(mocks.updateMessageType).toHaveBeenCalledWith('w1', '000000000000002', 'assistantRejected');
    expect(mocks.saveConversationHistory).toHaveBeenCalledWith('w1', expect.any(Object), 0, 'mermaidFeedback');
  });

  test('gives up after MAX_MERMAID_RETRIES and delivers broken mermaid', async () => {
    mocks.validateMermaidInText.mockResolvedValue({ valid: false, errors: [{ chart: 'bad', message: 'err' }] });

    // Provide enough getConversationHistory responses for 2 retries
    mocks.getConversationHistory
      .mockResolvedValueOnce({
        items: [
          {
            PK: 'message-w1',
            SK: '000000000000001',
            role: 'user',
            content: JSON.stringify([{ text: 'draw' }]),
            tokenCount: 10,
            messageType: 'userMessage',
          },
        ],
        slackUserId: undefined,
      })
      .mockResolvedValueOnce({
        items: [
          {
            PK: 'message-w1',
            SK: '000000000000001',
            role: 'user',
            content: JSON.stringify([{ text: 'draw' }]),
            tokenCount: 10,
            messageType: 'userMessage',
          },
          {
            PK: 'message-w1',
            SK: '000000000000002',
            role: 'assistant',
            content: JSON.stringify([{ text: 'bad1' }]),
            tokenCount: 5,
            messageType: 'assistant',
          },
        ],
        slackUserId: undefined,
      })
      .mockResolvedValueOnce({
        items: [
          {
            PK: 'message-w1',
            SK: '000000000000001',
            role: 'user',
            content: JSON.stringify([{ text: 'draw' }]),
            tokenCount: 10,
            messageType: 'userMessage',
          },
          {
            PK: 'message-w1',
            SK: '000000000000003',
            role: 'user',
            content: JSON.stringify([{ text: 'fb1' }]),
            tokenCount: 5,
            messageType: 'mermaidFeedback',
          },
        ],
        slackUserId: undefined,
      })
      .mockResolvedValueOnce({
        items: [
          {
            PK: 'message-w1',
            SK: '000000000000001',
            role: 'user',
            content: JSON.stringify([{ text: 'draw' }]),
            tokenCount: 10,
            messageType: 'userMessage',
          },
          {
            PK: 'message-w1',
            SK: '000000000000003',
            role: 'user',
            content: JSON.stringify([{ text: 'fb1' }]),
            tokenCount: 5,
            messageType: 'mermaidFeedback',
          },
          {
            PK: 'message-w1',
            SK: '000000000000004',
            role: 'assistant',
            content: JSON.stringify([{ text: 'bad2' }]),
            tokenCount: 5,
            messageType: 'assistant',
          },
        ],
        slackUserId: undefined,
      })
      .mockResolvedValueOnce({
        items: [
          {
            PK: 'message-w1',
            SK: '000000000000001',
            role: 'user',
            content: JSON.stringify([{ text: 'draw' }]),
            tokenCount: 10,
            messageType: 'userMessage',
          },
          {
            PK: 'message-w1',
            SK: '000000000000005',
            role: 'user',
            content: JSON.stringify([{ text: 'fb2' }]),
            tokenCount: 5,
            messageType: 'mermaidFeedback',
          },
        ],
        slackUserId: undefined,
      });

    const backend: InferenceBackend = {
      kind: 'bedrock',
      runTurn: vi.fn(async () => ({
        assistantMessage: { role: 'assistant' as const, content: [{ text: 'still broken' }] },
        alreadyPersisted: true,
        previewText: '```mermaid\nbad\n```',
      })),
    };
    const cancel = { isCancelled: false, onCancel: () => () => {} };
    await runTurnWithBackend('w1', cancel as any, backend);

    // 1 initial + 2 retries = 3 total
    expect(backend.runTurn).toHaveBeenCalledTimes(3);
    // After exhausting retries, finalizeTurn still runs (delivers broken mermaid)
    expect(mocks.sendSystemMessage).toHaveBeenCalled();
  });

  test('skips validation when previewText is empty', async () => {
    const backend: InferenceBackend = {
      kind: 'bedrock',
      runTurn: vi.fn(async () => ({
        assistantMessage: { role: 'assistant' as const, content: [] },
        alreadyPersisted: true,
        previewText: '',
        skipFinalize: true,
      })),
    };
    const cancel = { isCancelled: false, onCancel: () => () => {} };
    await runTurnWithBackend('w1', cancel as any, backend);
    expect(mocks.validateMermaidInText).not.toHaveBeenCalled();
  });
});

// Regression: a child turn that ends abnormally (e.g. Kiro "Prompt failed
// after retry") on a NON-agentMessage trigger (eventTrigger / systemRetrigger)
// used to leave the parent waiting forever, because finalizeTurn's parent
// redirect only fires for agentMessage-triggered turns and a backend that
// returns (does not throw) on give-up. The fix routes abnormalTermination
// through notifyTermination unconditionally for child sessions.
describe('runTurnWithBackend abnormal termination → parent wake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConversationHistory.mockResolvedValue({
      items: [
        {
          PK: 'message-w1',
          SK: '000000000001000',
          role: 'user',
          messageType: 'eventTrigger',
          content: JSON.stringify([{ text: 'tick' }]),
          tokenCount: 0,
        },
      ],
      slackUserId: undefined,
    });
    mocks.repairDanglingToolUse.mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mocks.getSession.mockResolvedValue({ workerId: 'w1', parentSessionId: 'p1' } as any);
    mocks.getCustomAgent.mockResolvedValue(undefined);
    mocks.readMetadata.mockResolvedValue(undefined);
    mocks.readCommonPrompt.mockResolvedValue(undefined);
  });

  const cancellable = { isCancelled: false };
  const makeBackend = (runTurn: InferenceBackend['runTurn']): InferenceBackend => ({ kind: 'bedrock', runTurn });

  test('abnormal turn on a non-agentMessage trigger still wakes the parent', async () => {
    const backend = makeBackend(async () => ({
      assistantMessage: { role: 'assistant', content: [{ text: 'fail' }] },
      alreadyPersisted: true,
      previewText: '[System] Prompt failed after retry: boom',
      abnormalTermination: { reason: '[System] Prompt failed after retry: boom (gave up after 3 retries)' },
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(mocks.sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionIds: ['p1'],
        message: expect.stringContaining('[Child error]'),
      })
    );
  });

  test('normal completion does NOT wake the parent (no over-wake)', async () => {
    const backend = makeBackend(async () => ({
      assistantMessage: { role: 'assistant', content: [{ text: 'done' }] },
      alreadyPersisted: true,
      previewText: 'all good',
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });

  test('abnormal turn on an agentMessage trigger notifies once (no double via redirect)', async () => {
    mocks.getConversationHistory.mockResolvedValue({
      items: [
        {
          PK: 'message-w1',
          SK: '000000000001000',
          role: 'user',
          messageType: 'agentMessage',
          content: JSON.stringify([{ text: 'do work' }]),
          tokenCount: 0,
        },
      ],
      slackUserId: undefined,
    });
    const backend = makeBackend(async () => ({
      assistantMessage: { role: 'assistant', content: [{ text: 'fail' }] },
      alreadyPersisted: true,
      previewText: '[System] Prompt failed after retry: boom',
      abnormalTermination: { reason: 'boom' },
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(mocks.sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('[Child error]') })
    );
  });

  test('auto-retry turn (retrigger, not give-up) does NOT wake the parent', async () => {
    let n = 0;
    const backend = makeBackend(async () => {
      n++;
      if (n === 1) {
        return {
          assistantMessage: { role: 'assistant', content: [{ text: 'fail' }] },
          alreadyPersisted: true,
          previewText: '[System] Prompt failed after retry: boom',
          retrigger: true,
          retriggerDelayMs: 1,
        };
      }
      return {
        assistantMessage: { role: 'assistant', content: [{ text: 'recovered' }] },
        alreadyPersisted: true,
        previewText: 'recovered',
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runTurnWithBackend('w1', cancellable as any, backend, undefined);

    expect(n).toBe(2);
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });
});

describe('buildTurnContext cwd fallback on compute hop', () => {
  const cancellable = { isCancelled: false, onCancel: () => () => {} };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.getConversationHistory.mockResolvedValue({
      items: [
        {
          PK: 'message-w1',
          SK: '000000000001000',
          role: 'user',
          messageType: 'userMessage',
          content: JSON.stringify([{ text: 'hello' }]),
          tokenCount: 0,
        },
      ],
      slackUserId: undefined,
    });
    mocks.repairDanglingToolUse.mockResolvedValue([]);
    mocks.getSession.mockResolvedValue(undefined);
    mocks.getCustomAgent.mockResolvedValue(undefined);
    mocks.readCommonPrompt.mockResolvedValue(undefined);
    mocks.shouldSuppressUserDelivery.mockResolvedValue(false);
    mocks.shouldSuppressRehashOrSelfNarration.mockResolvedValue(false);
    mocks.shouldSuppressWakeupMonologueDelivery.mockResolvedValue(false);
  });

  test('falls back to default cwd when repoDirectory does not exist', async () => {
    mocks.readMetadata.mockResolvedValue({
      repoOrg: 'owner',
      repoName: 'repo',
      isFork: false,
      repoDirectory: `${process.env.HOME || '/root'}/.remote-swe-workspace/nonexistent-repo`,
    });
    mocks.existsSync.mockReturnValue(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.cwd).toBe(join(homedir(), '.remote-swe-workspace'));
    expect(mocks.writeMetadata).toHaveBeenCalledWith(
      'repo',
      { repoOrg: 'owner', repoName: 'repo', isFork: false },
      'w1'
    );
  });

  test('uses repoDirectory when it exists', async () => {
    mocks.readMetadata.mockResolvedValue({
      repoOrg: 'owner',
      repoName: 'repo',
      isFork: false,
      repoDirectory: `${process.env.HOME || '/root'}/.remote-swe-workspace/existing-repo`,
    });
    mocks.existsSync.mockReturnValue(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.cwd).toBe(`${process.env.HOME || '/root'}/.remote-swe-workspace/existing-repo`);
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
  });

  test('uses default cwd when no repoDirectory in metadata', async () => {
    mocks.readMetadata.mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.cwd).toBe(join(homedir(), '.remote-swe-workspace'));
    expect(mocks.writeMetadata).not.toHaveBeenCalled();
  });
});

describe('buildTurnContext injects session title into system prompt', () => {
  const cancellable = { isCancelled: false, onCancel: () => () => {} };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(false);
    mocks.getConversationHistory.mockResolvedValue({
      items: [
        {
          PK: 'message-w1',
          SK: '000000000001000',
          role: 'user',
          messageType: 'userMessage',
          content: JSON.stringify([{ text: 'hello' }]),
          tokenCount: 0,
        },
      ],
      slackUserId: undefined,
    });
    mocks.repairDanglingToolUse.mockResolvedValue([]);
    mocks.getCustomAgent.mockResolvedValue(undefined);
    mocks.readCommonPrompt.mockResolvedValue(undefined);
    mocks.readMetadata.mockResolvedValue(undefined);
    mocks.shouldSuppressUserDelivery.mockResolvedValue(false);
    mocks.shouldSuppressRehashOrSelfNarration.mockResolvedValue(false);
    mocks.shouldSuppressWakeupMonologueDelivery.mockResolvedValue(false);
  });

  test('includes Session Context section when session has a title', async () => {
    mocks.getSession.mockResolvedValue({ title: 'Preview feature dev / deploy' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.systemPrompt).toContain('## Session Context');
    expect(ctx!.systemPrompt).toContain('Preview feature dev / deploy');
  });

  test('omits Session Context section when title is empty', async () => {
    mocks.getSession.mockResolvedValue({ title: '' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.systemPrompt).not.toContain('## Session Context');
  });

  test('omits Session Context section when title is undefined', async () => {
    mocks.getSession.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.systemPrompt).not.toContain('## Session Context');
  });

  test('omits Session Context section when session is undefined', async () => {
    mocks.getSession.mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.systemPrompt).not.toContain('## Session Context');
  });

  test('sanitizes title with newlines by collapsing to single line', async () => {
    mocks.getSession.mockResolvedValue({ title: 'Line1\nLine2\r\nLine3' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.systemPrompt).toContain('## Session Context');
    expect(ctx!.systemPrompt).toContain('Line1 Line2 Line3');
    expect(ctx!.systemPrompt).not.toContain('\n"');
  });

  test('sanitizes title with embedded quotes and markdown headings', async () => {
    mocks.getSession.mockResolvedValue({ title: 'Fix "bug" in ## header parsing' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.systemPrompt).toContain('Fix "bug" in ## header parsing');
  });

  test('truncates title longer than 100 characters', async () => {
    const longTitle = 'A'.repeat(150);
    mocks.getSession.mockResolvedValue({ title: longTitle });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = await buildTurnContext('w1', cancellable as any, undefined);

    expect(ctx).toBeDefined();
    expect(ctx!.systemPrompt).toContain('## Session Context');
    const match = ctx!.systemPrompt.match(/Session title: "([^"]+)"/);
    expect(match).toBeTruthy();
    expect(match![1]!.length).toBeLessThanOrEqual(100);
  });
});
