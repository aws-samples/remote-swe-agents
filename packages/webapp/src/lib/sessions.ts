import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';

export type SessionInfo = {
  workerId: string;
  instanceStatus?: 'starting' | 'running' | 'stopped' | 'terminated';
  createdAt?: number;
};
