import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import { searchSessionContent, SearchScope } from '../../lib/search-sessions';

const inputSchema = z.object({
  query: z.string().min(1).max(200).describe('The keyword or phrase to search for (case-insensitive partial match).'),
  scope: z
    .enum(['session', 'tree', 'all'])
    .describe(
      'Search scope:\n' +
        '- "session": Search within a single session (requires sessionId)\n' +
        '- "tree": Search within a parent session and all its descendants (requires sessionId)\n' +
        '- "all": Search across all sessions (expensive, may take tens of seconds)'
    ),
  sessionId: z
    .string()
    .optional()
    .describe(
      'Session ID to search within or to use as tree root. Defaults to the current session if omitted (for scope "session" and "tree").'
    ),
  maxResults: z.number().int().min(1).max(200).optional().describe('Maximum number of results to return. Default: 50.'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .describe('Timeout in milliseconds. Default: 30000. Search stops and returns partial results if exceeded.'),
});

const name = 'searchSessions';

export const searchSessionsTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name,
  handler: async (input: z.infer<typeof inputSchema>, context) => {
    const { query, scope, maxResults, timeoutMs } = input;
    const sessionId = input.sessionId ?? context.workerId;

    if ((scope === 'session' || scope === 'tree') && !sessionId) {
      return `Error: sessionId is required when scope is "${scope}" and no current session context is available.`;
    }

    const result = await searchSessionContent({
      query,
      scope: scope as SearchScope,
      sessionId,
      maxResults,
      timeoutMs,
    });

    if (result.results.length === 0) {
      return `No messages found matching "${query}" (searched ${result.totalSessions} session(s)).`;
    }

    const lines = result.results.map((hit) => {
      const time = new Date(hit.timestamp).toISOString();
      const session = hit.sessionTitle !== hit.sessionId ? `${hit.sessionId} (${hit.sessionTitle})` : hit.sessionId;
      return `[${time}] session=${session} role=${hit.role} type=${hit.messageType}\n  ${hit.snippet}`;
    });

    let output = `Found ${result.results.length} match(es) across ${result.totalSessions} session(s)`;
    if (result.timedOut) {
      output += ' (timed out, results may be incomplete)';
    }
    if (result.results.length >= (maxResults || 50)) {
      output += ' (results truncated, narrow your search or increase maxResults)';
    }
    if (result.warning) {
      output += `\nWarning: ${result.warning}`;
    }
    output += ':\n\n' + lines.join('\n\n');

    return output;
  },
  schema: inputSchema,
  toolSpec: async () => ({
    name,
    description: `Search session message history by keyword (case-insensitive partial match).

Use this to find specific conversations, decisions, or information across sessions.

## Scopes:
- "session": Search within a single session (fast)
- "tree": Search a parent session and all its child/grandchild sessions (moderate)
- "all": Search across ALL sessions (may take tens of seconds for large workspaces)

## Tips:
- Use scope="session" or "tree" when you know which session(s) to search
- Use scope="all" sparingly — it queries every session's messages
- Results are sorted by timestamp (newest first) and include a snippet with surrounding context
- The search covers user messages, assistant responses, tool use messages, agent messages, event triggers, and communication logs`,
    inputSchema: {
      json: zodToJsonSchemaBody(inputSchema),
    },
  }),
};
