/**
 * Compose the effective system prompt by appending the dynamic per-turn
 * environment block (context-usage self-regulation hint). Used by the ACP SDK
 * loop; same logic as the legacy kiroAgentLoop (kiro-agent-loop.ts L2951-2952).
 */
export const composeSystemPrompt = (systemPrompt: string, environmentBlock: string | undefined): string =>
  environmentBlock ? `${systemPrompt}\n\n${environmentBlock}` : systemPrompt;
