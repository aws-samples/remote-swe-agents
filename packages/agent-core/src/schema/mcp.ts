import z from 'zod';

export const mcpConfigSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.union([
      z.object({
        command: z.string(),
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()).optional(),
        enabled: z.boolean().optional(),
      }),
      z.object({
        url: z.string(),
        enabled: z.boolean().optional(),
      }),
    ])
  ),
});
