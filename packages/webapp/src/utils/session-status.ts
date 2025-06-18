import { AgentStatus, InstanceStatus } from '@remote-swe-agents/agent-core/schema';

export type StatusI18nKey =
  | 'agentStatus.completed'
  | 'agentStatus.pending'
  | 'agentStatus.working'
  | 'agentStatus.unknown'
  | 'sessionStatus.stopped'
  | 'sessionStatus.starting';

export interface UnifiedStatusResult {
  i18nKey: StatusI18nKey;
  color: string;
}

export function getUnifiedStatus(
  agentStatus: AgentStatus | undefined,
  instanceStatus: InstanceStatus | undefined
): UnifiedStatusResult {
  if (instanceStatus === 'starting') {
    return { i18nKey: 'sessionStatus.starting', color: 'bg-blue-500' };
  }
  if (agentStatus === 'completed') {
    return { i18nKey: 'agentStatus.completed', color: 'bg-gray-500' };
  }
  if (instanceStatus === 'stopped' || instanceStatus === 'terminated') {
    return { i18nKey: 'sessionStatus.stopped', color: 'bg-gray-500' };
  }
  if (agentStatus === 'pending') {
    return { i18nKey: 'agentStatus.pending', color: 'bg-yellow-500' };
  }
  if (agentStatus === 'working') {
    return { i18nKey: 'agentStatus.working', color: 'bg-green-500' };
  }
  return { i18nKey: 'agentStatus.unknown', color: 'bg-gray-400' };
}
