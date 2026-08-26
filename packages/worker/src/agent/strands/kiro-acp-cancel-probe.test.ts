/**
 * Non-lethal stuck recovery — cancel-probe interpretation + tunables.
 * Exercises the REAL production functions (interpretCancelProbeMessage,
 * kiroCancelAckTimeoutMs, kiroCancelProbeEnabled).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ActiveSessionMessage, SessionNotification, PromptResponse } from '@agentclientprotocol/sdk';
import { interpretCancelProbeMessage, kiroCancelAckTimeoutMs, kiroCancelProbeEnabled } from './kiro-acp-agent';

const stopMsg = (stopReason: string): ActiveSessionMessage => ({
  kind: 'stop',
  response: { stopReason } as PromptResponse,
  stopReason: stopReason as PromptResponse['stopReason'],
});

const updateMsg = (): ActiveSessionMessage => {
  const notification = {
    sessionId: 'sess-1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed' } },
  } as unknown as SessionNotification;
  return {
    kind: 'session_update',
    notification,
    update: notification.update,
  };
};

describe('interpretCancelProbeMessage', () => {
  it('a cancelled stop is an ack → alive-cancelled (re-prompt same session)', () => {
    const res = interpretCancelProbeMessage(stopMsg('cancelled'));
    expect(res.outcome).toBe('alive-cancelled');
    expect(res.stopMessage?.stopReason).toBe('cancelled');
  });

  it('a non-cancelled stop (end_turn/max_tokens) is a COMPLETED turn, not alive-cancelled', () => {
    // The prompt actually FINISHED during the probe window (agent was slow, not
    // wedged). It must be returned as the turn result, NOT re-prompted — a
    // re-prompt would re-run a completed turn and double its side effects.
    const endTurn = interpretCancelProbeMessage(stopMsg('end_turn'));
    expect(endTurn.outcome).toBe('completed');
    expect(endTurn.stopMessage?.stopReason).toBe('end_turn');

    const maxTokens = interpretCancelProbeMessage(stopMsg('max_tokens'));
    expect(maxTokens.outcome).toBe('completed');
    expect(maxTokens.stopMessage?.stopReason).toBe('max_tokens');
  });

  it('a real session_update proves liveness AND carries progress → alive-updated + pending', () => {
    const msg = updateMsg();
    const res = interpretCancelProbeMessage(msg);
    expect(res.outcome).toBe('alive-updated');
    expect(res.pending).toBe(msg.kind === 'session_update' ? msg.update : undefined);
  });
});

describe('cancel-probe tunables', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('kiroCancelAckTimeoutMs default 5000, override honored, invalid falls back', () => {
    expect(kiroCancelAckTimeoutMs()).toBe(5000);
    vi.stubEnv('KIRO_ACP_CANCEL_ACK_TIMEOUT_MS', '1500');
    expect(kiroCancelAckTimeoutMs()).toBe(1500);
    vi.stubEnv('KIRO_ACP_CANCEL_ACK_TIMEOUT_MS', 'abc');
    expect(kiroCancelAckTimeoutMs()).toBe(5000);
  });

  it('kiroCancelProbeEnabled default ON, off-forms disable', () => {
    expect(kiroCancelProbeEnabled()).toBe(true);
    for (const off of ['0', 'false', 'off', 'no']) {
      vi.stubEnv('KIRO_ACP_CANCEL_PROBE', off);
      expect(kiroCancelProbeEnabled()).toBe(false);
    }
    vi.stubEnv('KIRO_ACP_CANCEL_PROBE', 'on');
    expect(kiroCancelProbeEnabled()).toBe(true);
  });
});
