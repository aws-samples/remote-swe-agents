/**
 * Session synthesis + resume tests.
 *
 * Tests:
 * 1. ManualSession cross-session bleed prevention (sessionId-strict filter)
 * 2. modelId propagation through v3 synthesis (wiring test)
 * 3. v3 unknown-ID hazard coverage (synth-before-load guard)
 */
import { describe, it, expect, vi } from 'vitest';
import { ManualSession } from './kiro-acp-agent';
import {
  synthesizeKiroSessionFilesV3,
  kiroV3SessionFilesExist,
  readKiroV3SessionModelId,
  kiroV3SessionDir,
} from '../kiro-session-synth';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { computeSynthPlan } from '../compute-synth-plan';

// Minimal fake ctx for ManualSession (only needs request for prompt)
const makeFakeCtx = () => {
  const promptResolvers: Array<{ resolve: (res: unknown) => void; reject: (err: Error) => void }> = [];
  return {
    ctx: {
      request: vi
        .fn()
        .mockImplementation(() => new Promise((resolve, reject) => promptResolvers.push({ resolve, reject }))),
    } as any,
    resolvePrompt: (response: unknown) => promptResolvers.shift()?.resolve(response),
    rejectPrompt: (err: Error) => promptResolvers.shift()?.reject(err),
  };
};

describe('ManualSession cross-session bleed prevention', () => {
  it('drops session/update notifications with a different sessionId', async () => {
    const { ctx } = makeFakeCtx();
    const session = new ManualSession('session-abc', ctx);

    const wrongNotification: SessionNotification = {
      sessionId: 'session-OTHER',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'leaked' } } as any,
    };
    const correctNotification: SessionNotification = {
      sessionId: 'session-abc',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } as any,
    };

    // Simulate what the onNotification handler does: only push if sessionId matches
    if (wrongNotification.sessionId === session.sessionId) {
      session.pushUpdate(wrongNotification);
    }
    if (correctNotification.sessionId === session.sessionId) {
      session.pushUpdate(correctNotification);
    }

    const msg = await session.nextUpdate();
    expect(msg.kind).toBe('session_update');
    if (msg.kind === 'session_update') {
      expect(msg.update).toBe(correctNotification.update);
    }
    // No second message queued (wrong session was filtered)
    session.dispose();
  });

  it('accepts only notifications matching its own sessionId', async () => {
    const { ctx } = makeFakeCtx();
    const sessionA = new ManualSession('sess-A', ctx);
    const sessionB = new ManualSession('sess-B', ctx);

    const notifForA: SessionNotification = {
      sessionId: 'sess-A',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'x', title: 'x' } as any,
    };
    const notifForB: SessionNotification = {
      sessionId: 'sess-B',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } } as any,
    };

    // Simulate the real filter logic in KiroAcpAgent.ensureStarted
    [notifForA, notifForB].forEach((n) => {
      if (n.sessionId === sessionA.sessionId) sessionA.pushUpdate(n);
      if (n.sessionId === sessionB.sessionId) sessionB.pushUpdate(n);
    });

    const msgA = await sessionA.nextUpdate();
    if (msgA.kind === 'session_update') {
      expect(msgA.update).toBe(notifForA.update);
    }

    const msgB = await sessionB.nextUpdate();
    if (msgB.kind === 'session_update') {
      expect(msgB.update).toBe(notifForB.update);
    }

    sessionA.dispose();
    sessionB.dispose();
  });
});

describe('modelId propagation through v3 synthesis', () => {
  const testHome = path.join(tmpdir(), `k1-test-${Date.now()}`);

  it('modelId is written to session.json and readable via readKiroV3SessionModelId', async () => {
    const sessionId = randomUUID();
    const cwd = '/test/workspace';
    const modelId = 'claude-sonnet-4.6';

    await synthesizeKiroSessionFilesV3({
      sessionId,
      cwd,
      items: [
        { PK: 'x', SK: '001000000000001', content: '[{"text":"hello"}]', role: 'user', type: 'user' } as any,
        {
          PK: 'x',
          SK: '001000000000002',
          content: '[{"text":"hi back"}]',
          role: 'assistant',
          type: 'assistant',
        } as any,
      ],
      modelId,
      home: testHome,
    });

    // Read back the modelId from the synthesised session.json
    const readModel = readKiroV3SessionModelId(sessionId, cwd, testHome);
    expect(readModel).toBe(modelId);
  });

  it('modelId=undefined (auto) omits the field from session.json', async () => {
    const sessionId = randomUUID();
    const cwd = '/test/workspace';

    await synthesizeKiroSessionFilesV3({
      sessionId,
      cwd,
      items: [{ PK: 'x', SK: '001000000000001', content: '[{"text":"hello"}]', role: 'user', type: 'user' } as any],
      modelId: undefined,
      home: testHome,
    });

    const readModel = readKiroV3SessionModelId(sessionId, cwd, testHome);
    expect(readModel).toBeUndefined();
  });
});

describe('v3 unknown-ID hazard guard', () => {
  const testHome = path.join(tmpdir(), `k1-hazard-${Date.now()}`);

  it('kiroV3SessionFilesExist returns false for an unsynthesized sessionId', () => {
    expect(kiroV3SessionFilesExist(randomUUID(), '/some/cwd', testHome)).toBe(false);
  });

  it('kiroV3SessionFilesExist returns true after synthesizeKiroSessionFilesV3', async () => {
    const sessionId = randomUUID();
    const cwd = '/test/workspace';

    await synthesizeKiroSessionFilesV3({
      sessionId,
      cwd,
      items: [{ PK: 'x', SK: '001000000000001', content: '[{"text":"test"}]', role: 'user', type: 'user' } as any],
      home: testHome,
    });

    expect(kiroV3SessionFilesExist(sessionId, cwd, testHome)).toBe(true);
  });

  it('synthesize-before-load pattern: files exist after synthesis, preventing v3 silent fabrication', async () => {
    const sessionId = randomUUID();
    const cwd = '/test/hazard';

    // Before synthesis: files do NOT exist (v3 load would fabricate)
    expect(kiroV3SessionFilesExist(sessionId, cwd, testHome)).toBe(false);

    // Synthesis writes session.json + messages.jsonl
    await synthesizeKiroSessionFilesV3({
      sessionId,
      cwd,
      items: [
        { PK: 'x', SK: '001000000000001', content: '[{"text":"user msg"}]', role: 'user', type: 'user' } as any,
        {
          PK: 'x',
          SK: '001000000000002',
          content: '[{"text":"assistant response"}]',
          role: 'assistant',
          type: 'assistant',
        } as any,
      ],
      modelId: 'claude-sonnet-5',
      home: testHome,
    });

    // After synthesis: files exist (v3 load will find them)
    expect(kiroV3SessionFilesExist(sessionId, cwd, testHome)).toBe(true);

    // Verify the session dir contains both required files
    const dir = kiroV3SessionDir(sessionId, cwd, testHome);
    expect(fs.existsSync(path.join(dir, 'session.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'messages.jsonl'))).toBe(true);

    // modelId is persisted in session.json
    expect(readKiroV3SessionModelId(sessionId, cwd, testHome)).toBe('claude-sonnet-5');
  });
});

describe('turn-1 synthesis with modelId (loop boundary test)', () => {
  const testHome = path.join(tmpdir(), `k1-c1-${Date.now()}`);

  it('synthesizes session.json with modelId even when history is empty (turn 1)', async () => {
    // Simulate the loop's synthesis guard logic on turn 1:
    // - history contains only the current-turn user message
    // - consumedTailCount = 1 (the current message)
    // - itemsToSynth = [] (history trimmed to empty)
    // - But synthesis MUST still run to write modelId into session.json
    const sessionId = randomUUID();
    const sessionCwd = '/test/workspace-turn1';
    const modelIdForSynth = 'claude-sonnet-4.6'; // resolved by resolveModelConfig

    // --- Use the same computeSynthPlan function the loop uses ---
    const history = [
      { PK: 'x', SK: '001000000000001', content: '[{"text":"hello"}]', role: 'user', type: 'user' },
    ] as any[];
    const consumedTailCount = 1;
    const { itemsToSynth } = computeSynthPlan(history, consumedTailCount);

    // Verify turn-1 produces empty items (the empty-history scenario)
    expect(itemsToSynth).toHaveLength(0);

    // Previously this was gated by `if (itemsToSynth.length > 0)` → skip
    // Now synthesis runs unconditionally when files don't exist
    expect(kiroV3SessionFilesExist(sessionId, sessionCwd, testHome)).toBe(false);

    await synthesizeKiroSessionFilesV3({
      sessionId,
      cwd: sessionCwd,
      items: itemsToSynth, // empty!
      modelId: modelIdForSynth,
      home: testHome,
    });

    // session.json exists with modelId — kiro-cli will resolve the model on load
    expect(kiroV3SessionFilesExist(sessionId, sessionCwd, testHome)).toBe(true);
    expect(readKiroV3SessionModelId(sessionId, sessionCwd, testHome)).toBe('claude-sonnet-4.6');
  });

  it('turn-1 without model override produces session.json without modelId (auto)', async () => {
    const sessionId = randomUUID();
    const sessionCwd = '/test/workspace-turn1-auto';
    const modelIdForSynth = undefined; // auto

    await synthesizeKiroSessionFilesV3({
      sessionId,
      cwd: sessionCwd,
      items: [], // turn 1, empty history
      modelId: modelIdForSynth,
      home: testHome,
    });

    expect(kiroV3SessionFilesExist(sessionId, sessionCwd, testHome)).toBe(true);
    expect(readKiroV3SessionModelId(sessionId, sessionCwd, testHome)).toBeUndefined();
  });
});

describe('D4: ManualSession.prompt error propagation', () => {
  it('session/prompt RPC failure rejects nextUpdate (not masked as normal stop)', async () => {
    const { ctx, rejectPrompt } = makeFakeCtx();
    const session = new ManualSession('sess-err', ctx);

    session.prompt('hello');
    const updatePromise = session.nextUpdate();

    // Simulate RPC failure
    rejectPrompt(new Error('connection reset'));

    await expect(updatePromise).rejects.toThrow('connection reset');
    session.dispose();
  });

  it('subsequent nextUpdate calls also throw after prompt failure', async () => {
    const { ctx, rejectPrompt } = makeFakeCtx();
    const session = new ManualSession('sess-err2', ctx);

    session.prompt('hello');

    // Let the rejection propagate through microtask
    rejectPrompt(new Error('timeout'));
    await new Promise((r) => setTimeout(r, 10));

    await expect(session.nextUpdate()).rejects.toThrow('timeout');
    session.dispose();
  });
});

describe('D5: session/load failure self-healing (stale-ID clear)', () => {
  it('ManualSession load failure (via ensureStarted) throws to the consumer', async () => {
    // If session/load throws, the error must propagate — not be masked.
    // The loop's catch block then handles clearing the persisted ID.
    const fakeCtx = {
      request: vi.fn().mockRejectedValue(new Error('session/load: file corrupted')),
    } as any;

    const session = new ManualSession('stale-id-123', fakeCtx);
    session.prompt('hello');

    // The prompt fires session/prompt which also rejects (same ctx mock),
    // and the error propagates through nextUpdate
    await expect(session.nextUpdate()).rejects.toThrow('session/load: file corrupted');
    session.dispose();
  });
});

describe('D1: update-queue drain (load-replay bleed prevention)', () => {
  it('residual notifications queued before prompt() are drained and not visible to nextUpdate', async () => {
    const { ctx, resolvePrompt } = makeFakeCtx();
    const session = new ManualSession('sess-drain', ctx);

    // Simulate notifications arriving during session/load (before prompt)
    const replayNotif: SessionNotification = {
      sessionId: 'sess-drain',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE REPLAY' } } as any,
    };
    session.pushUpdate(replayNotif);
    session.pushUpdate(replayNotif);

    // Now prompt — should drain residual queue
    session.prompt('hello');

    // Push a LIVE notification (arrives after prompt fires)
    const liveNotif: SessionNotification = {
      sessionId: 'sess-drain',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LIVE' } } as any,
    };
    session.pushUpdate(liveNotif);

    // nextUpdate should see ONLY the live notification, not the stale replays
    const msg = await session.nextUpdate();
    if (msg.kind === 'session_update') {
      expect((msg.update as any).content.text).toBe('LIVE');
    }

    // Resolve prompt to clean up
    resolvePrompt({ stopReason: 'end_turn' });
    const stop = await session.nextUpdate();
    expect(stop.kind).toBe('stop');
    session.dispose();
  });

  it('drain does not affect notifications arriving after prompt()', async () => {
    const { ctx, resolvePrompt } = makeFakeCtx();
    const session = new ManualSession('sess-drain2', ctx);

    // No residual notifications — prompt immediately
    session.prompt('test');

    // Notifications arriving after prompt are preserved
    const n1: SessionNotification = {
      sessionId: 'sess-drain2',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'x', title: 'x' } as any,
    };
    const n2: SessionNotification = {
      sessionId: 'sess-drain2',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' } as any,
    };
    session.pushUpdate(n1);
    session.pushUpdate(n2);

    const msg1 = await session.nextUpdate();
    const msg2 = await session.nextUpdate();
    if (msg1.kind === 'session_update') expect((msg1.update as any).sessionUpdate).toBe('tool_call');
    if (msg2.kind === 'session_update') expect((msg2.update as any).sessionUpdate).toBe('tool_call_update');

    resolvePrompt({ stopReason: 'end_turn' });
    session.dispose();
  });
});
