import { getSession, getChildSessions, resolveAgentDisplayName } from '@remote-swe-agents/agent-core/lib';
import { SessionItem } from '@remote-swe-agents/agent-core/schema';

export const buildSessionHierarchyPrompt = async (workerId: string, session: SessionItem): Promise<string> => {
  const hierarchyLines: string[] = [];
  const selfName = await resolveAgentDisplayName(session);

  if (session.parentSessionId) {
    const parentSession = await getSession(session.parentSessionId);
    const parentName = parentSession ? await resolveAgentDisplayName(parentSession) : session.parentSessionId;
    hierarchyLines.push(`You are a child agent "${selfName}" (Session ID: ${workerId}).`);
    hierarchyLines.push(`Parent: "${parentName}" (Session ID: ${session.parentSessionId})`);
    hierarchyLines.push('');
    hierarchyLines.push('### Message Routing Rules for Child Sessions');
    hierarchyLines.push('Always reply to whoever sent you the message:');
    hierarchyLines.push(
      '- **Parent agent** (via `Send Message To Agent`) → Reply with `Send Message To Agent` to the parent.'
    );
    hierarchyLines.push("- **User** (typed directly in this session's WebUI) → Reply with `sendMessageToUser`.");
    hierarchyLines.push('- **Event trigger** (no sender) → Report to the parent with `Send Message To Agent`.');
    hierarchyLines.push('');
    hierarchyLines.push(
      'IMPORTANT: After calling `Send Message To User` or `Send Message To Agent`, end your turn with NO text output. Text output at end-of-turn is also delivered to the user, causing duplicate messages.'
    );
    hierarchyLines.push('Use `Acknowledge Agent` for lightweight responses that do not need immediate action.');

    const siblings = await getChildSessions(session.parentSessionId);
    const otherSiblings = siblings.filter((s) => s.workerId !== workerId);
    if (otherSiblings.length > 0) {
      hierarchyLines.push('');
      hierarchyLines.push('Siblings:');
      for (const sib of otherSiblings) {
        const sibName = await resolveAgentDisplayName(sib);
        hierarchyLines.push(`- "${sibName}" (Session ID: ${sib.workerId})`);
      }
    }
  } else {
    const children = await getChildSessions(workerId);
    if (children.length > 0) {
      hierarchyLines.push(`You are a parent agent "${selfName}" (Session ID: ${workerId}).`);
      hierarchyLines.push('Your child agents:');
      for (const child of children) {
        const childName = await resolveAgentDisplayName(child);
        hierarchyLines.push(`- "${childName}" (Session ID: ${child.workerId})`);
      }
    }

    if (session.creatorSessionId) {
      const creatorSession = await getSession(session.creatorSessionId);
      const creatorName = creatorSession ? await resolveAgentDisplayName(creatorSession) : session.creatorSessionId;
      hierarchyLines.push('');
      hierarchyLines.push(`This session was created by: "${creatorName}" (Session ID: ${session.creatorSessionId})`);
      hierarchyLines.push(
        'You can use Send Message To Agent to communicate with the creator session if you need more context or have questions.'
      );
    }
  }

  if (hierarchyLines.length === 0) return '';

  hierarchyLines.push('');
  hierarchyLines.push('Use Send Message To Agent to send messages to other agents by session ID.');
  hierarchyLines.push('Use Acknowledge Agent to respond without waking up the target (like a read receipt).');
  hierarchyLines.push('');
  hierarchyLines.push('### Session Role Selection');
  hierarchyLines.push('When creating new sessions with `Create New Session`, the `role` parameter is required:');
  hierarchyLines.push(
    "- **role='child'**: Sub-task of the current session. Current session becomes the parent. Use when the task is directly related to your current work."
  );
  hierarchyLines.push(
    "- **role='successor'**: Hand over to a fresh parent (session handover). Current session + its children are re-parented under the new session. Use when the user asks for a handover."
  );
  hierarchyLines.push(
    "- **role='independent'**: A completely separate session for an unrelated topic. Independent sessions persist on their own."
  );
  hierarchyLines.push('');
  hierarchyLines.push('Examples:');
  hierarchyLines.push(
    '- Current session is about "API performance tuning" → Run a load test → role=\'child\' (sub-task of the same topic)'
  );
  hierarchyLines.push('- User says "hand over" / "take over" → role=\'successor\' (create fresh coordinator)');
  hierarchyLines.push(
    '- Current session is about "API performance tuning" → Fix a typo in the README → role=\'independent\' (unrelated topic)'
  );

  return `\n\n## Session Hierarchy\n${hierarchyLines.join('\n')}`;
};
