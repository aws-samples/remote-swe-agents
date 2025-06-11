/**
 * Agent status types
 */

export type AgentStatus = 'working' | 'pending' | 'completed';

export const isAgentStatus = (status: string): status is AgentStatus =>
  ['working', 'pending', 'completed'].includes(status);
