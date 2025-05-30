import { z } from 'zod';

export const createNewWorkerSchema = z.object({ message: z.string().min(1) });
