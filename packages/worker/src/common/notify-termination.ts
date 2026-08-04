import {
  getSession,
  sendAgentMessage,
  incrementUnread,
  sendPushNotificationToUser,
} from '@remote-swe-agents/agent-core/lib';

export type TerminationKind = 'error' | 'sleeping';

/**
 * Notify the owner of a worker session about an abnormal termination.
 *
 * Routing rules:
 * - parentSessionId set (child of another agent)
 *     → agentMessage to parent ([Child error] / [Child sleeping])
 * - parentSessionId unset + initiator='webapp#<userId>' + kind='error'
 *     → user-facing push + unread bump (badge)
 * - parentSessionId unset + initiator='webapp#<userId>' + kind='sleeping'
 *     → no-op (silent terminate, matches pre-a745803 behaviour for top-level
 *       sleeps; user does not need a push for routine inactivity)
 * - parentSessionId unset + initiator='slack#...'
 *     → no-op (sendSystemMessage already delivered the notice to the slack thread)
 * - other / missing initiator
 *     → log warning, no-op (defensive: unknown initiator shape)
 *
 * Failures are swallowed and logged; this helper must never throw because it
 * runs from termination paths (catch blocks, kill timers, startup failure)
 * where re-throwing would mask the original error or leave the worker in a
 * partially-cleaned state.
 */
export const notifyTermination = async (workerId: string, kind: TerminationKind, reason: string): Promise<void> => {
  try {
    const session = await getSession(workerId);
    if (!session) return;

    if (session.parentSessionId) {
      const tag = kind === 'error' ? '[Child error]' : '[Child sleeping]';
      const detail =
        kind === 'error' ? ` encountered an error: ${reason.slice(0, 500)}` : ` is going to sleep due to inactivity.`;
      await sendAgentMessage({
        senderWorkerId: workerId,
        targetSessionIds: [session.parentSessionId],
        message: `${tag} Session ${workerId}${detail}`,
        acknowledge: kind === 'sleeping',
      });
      return;
    }

    const initiator = session.initiator;

    if (initiator?.startsWith('webapp#')) {
      // sleeping for a top-level webapp session is intentionally silent —
      // the assistant message ('Going to sleep mode...') was already
      // delivered by sendSystemMessage which fires a real-time webapp event.
      // No push / unread bump for routine inactivity.
      if (kind === 'sleeping') return;

      const userId = initiator.slice('webapp#'.length);
      const titleBase = session.title || workerId;
      const title = `[Error] ${titleBase}`.slice(0, 80);
      const body = `Session stopped due to error: ${reason.slice(0, 160)}`;
      await incrementUnread(userId, workerId);
      await sendPushNotificationToUser(userId, {
        title,
        body,
        url: `/sessions/${workerId}`,
        workerId,
      });
      return;
    }

    if (initiator?.startsWith('slack#')) {
      // Slack thread already received the assistant message via
      // sendSystemMessage → sendMessageToSlack on the upstream caller. No
      // additional push channel for slack-initiated sessions.
      return;
    }

    console.warn('[notify-termination] unknown initiator shape:', initiator);
  } catch (e) {
    console.error('[notify-termination] failed:', e);
  }
};
