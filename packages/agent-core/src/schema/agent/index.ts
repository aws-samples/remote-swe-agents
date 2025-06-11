/**
 * Agent status types
 */

import { z } from 'zod';

export const agentStatusSchema = z.union([z.literal('working'), z.literal('pending'), z.literal('completed')]);

export type AgentStatus = z.infer<typeof agentStatusSchema>;
