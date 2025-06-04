import { z } from 'zod';

export const sendMessageToAgentSchema = z.object({
  workerId: z.string(),
  message: z.string(),
  imageKeys: z.array(z.string()).optional(),
});

export const getSessionSchema = z.object({
  workerId: z.string(),
});

export type SessionInfo = {
  workerId: string;
  instanceStatus?: 'starting' | 'running' | 'sleeping' | 'terminated';
  createdAt?: number;
};

export type GetSessionResult = {
  session: SessionInfo;
};
