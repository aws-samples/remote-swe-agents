/**
 * Agent status types
 */

export type AgentStatus = 'working' | 'pending response' | 'completed';

export const isAgentStatus = (status: string): status is AgentStatus =>
  ['working', 'pending response', 'completed'].includes(status);