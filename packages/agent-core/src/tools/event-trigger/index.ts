import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import {
  createScheduleTrigger,
  createEventPatternTrigger,
  listEventTriggers,
  deleteEventTrigger,
} from '../../lib/event-triggers';

// --- createEventTrigger ---

const createInputSchema = z.object({
  name: z
    .string()
    .describe('A human-readable display name for this trigger. e.g. "Finetune Job Monitor", "5min Health Check"'),
  scheduleExpression: z
    .string()
    .optional()
    .describe(
      'Schedule expression for periodic triggers. e.g. rate(5 minutes), cron(0 12 * * ? *). Mutually exclusive with atExpression and eventPattern.'
    ),
  atExpression: z
    .string()
    .optional()
    .describe(
      'One-time schedule. Accepts ISO 8601 format (UTC) e.g. 2026-03-28T12:00:00, or relative time e.g. 30s, 5min, 2h, 1d. The trigger fires once and is automatically deleted. Mutually exclusive with scheduleExpression and eventPattern.'
    ),
  eventPattern: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      'EventBridge event pattern JSON for event-driven triggers. e.g. {"source":["aws.bedrock"],"detail-type":["Bedrock Model Customization Job State Change"]}. Mutually exclusive with scheduleExpression and atExpression.'
    ),
  message: z.string().describe('Message sent to you when this trigger fires. Include context about what to do.'),
  idleNotifyAfter: z
    .string()
    .optional()
    .describe(
      'Relative time duration for idle notification on event pattern triggers. If the event has not fired within this duration, you will be notified (the trigger remains active). e.g. 30s, 5min, 2h, 1d'
    ),
});

const getSfnArn = () => process.env.EVENT_TRIGGER_SFN_ARN ?? '';
const getSfnRoleArn = () => process.env.EVENT_TRIGGER_SFN_ROLE_ARN ?? '';
const getTtlSfnArn = () => process.env.EVENT_TRIGGER_TTL_SFN_ARN ?? '';
const getTtlSfnRoleArn = () => process.env.EVENT_TRIGGER_TTL_SFN_ROLE_ARN ?? '';

function parseRelativeTime(expr: string): string | null {
  const match = expr.match(/^(\d+)\s*(s|sec|min|m|h|hr|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  let ms = 0;
  if (unit === 's' || unit === 'sec') ms = value * 1000;
  else if (unit === 'min' || unit === 'm') ms = value * 60 * 1000;
  else if (unit === 'h' || unit === 'hr') ms = value * 60 * 60 * 1000;
  else if (unit === 'd') ms = value * 24 * 60 * 60 * 1000;
  const target = new Date(Date.now() + ms);
  return target.toISOString().replace(/\.\d{3}Z$/, '');
}

function formatUtcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

export const createEventTriggerTool: ToolDefinition<z.infer<typeof createInputSchema>> = {
  name: 'createEventTrigger',
  handler: async (input, context) => {
    const { workerId } = context;
    const { name, scheduleExpression, eventPattern, message: triggerMessage, idleNotifyAfter } = input;
    let { atExpression } = input;

    if (!name) return 'Error: name is required.';

    const specified = [scheduleExpression, atExpression, eventPattern].filter(Boolean).length;
    if (specified !== 1) {
      return 'Error: Exactly one of scheduleExpression, atExpression, or eventPattern must be specified.';
    }

    const now = formatUtcNow();

    if (atExpression) {
      const resolved = parseRelativeTime(atExpression);
      if (resolved) {
        atExpression = resolved;
      }
    }

    if (scheduleExpression || atExpression) {
      const expression = atExpression ? `at(${atExpression})` : scheduleExpression!;
      const trigger = await createScheduleTrigger({
        workerId,
        name,
        scheduleExpression: expression,
        message: triggerMessage,
        sfnArn: getSfnArn(),
        sfnRoleArn: getSfnRoleArn(),
      });
      const typeLabel = atExpression ? `one-time at ${atExpression} UTC` : `schedule: ${scheduleExpression}`;
      const fireInfo = atExpression ? `\n- Fires at (UTC): ${atExpression}` : '';
      return `Event trigger created successfully.\n- ID: ${trigger.SK}\n- Name: "${name}"\n- Type: ${typeLabel}\n- Message: "${triggerMessage}"\n- Current time (UTC): ${now}${fireInfo}`;
    }

    const trigger = await createEventPatternTrigger({
      workerId,
      name,
      eventPattern: eventPattern!,
      message: triggerMessage,
      idleNotifyAfter,
      sfnArn: getSfnArn(),
      sfnRoleArn: getSfnRoleArn(),
      ttlSfnArn: getTtlSfnArn(),
      ttlSfnRoleArn: getTtlSfnRoleArn(),
    });
    const idleInfo = idleNotifyAfter ? `\n- Idle notification: after ${idleNotifyAfter}` : '';
    return `Event trigger created successfully.\n- ID: ${trigger.SK}\n- Name: "${name}"\n- Type: event-pattern\n- Pattern: ${JSON.stringify(eventPattern)}\n- Message: "${triggerMessage}"${idleInfo}\n- Current time (UTC): ${now}`;
  },
  schema: createInputSchema,
  toolSpec: async () => ({
    name: 'createEventTrigger',
    description: `Create a new EventBridge event trigger for this session. Triggers can wake up the agent on a schedule or when specific AWS events occur.

## Trigger types:
1. **Schedule** (scheduleExpression): Recurring triggers using rate() or cron() expressions
   - Example: \`rate(5 minutes)\`, \`cron(0 12 * * ? *)\`
2. **One-time** (atExpression): Fires once at a specific time, then auto-deletes
   - Absolute: \`2026-03-28T12:00:00\` (ISO 8601, UTC)
   - Relative: \`30s\`, \`5min\`, \`2h\`, \`1d\` (from now)
3. **Event pattern** (eventPattern): Fires when matching AWS events occur on EventBridge
   - Example: \`{"source":["aws.bedrock"],"detail-type":["Bedrock Model Customization Job State Change"]}\`

## Behavior:
- When a trigger fires, you receive the configured message along with event details (for event patterns)
- Triggers persist even when the session is sleeping; the session will be woken up
- Event pattern triggers can have an idle notification (idleNotifyAfter) - you'll be notified if the event hasn't fired within the specified duration, but the trigger remains active
- Maximum 10 triggers per session
- One-time schedules are automatically cleaned up after firing

## Cost awareness:
- Recurring schedules invoke the agent repeatedly, incurring Bedrock API costs each time
- Prefer event patterns over polling schedules when possible (e.g. listen for job completion events instead of checking every N minutes)`,
    inputSchema: {
      json: zodToJsonSchemaBody(createInputSchema),
    },
  }),
};

// --- listEventTriggers ---

const listInputSchema = z.object({});

export const listEventTriggersTool: ToolDefinition<z.infer<typeof listInputSchema>> = {
  name: 'listEventTriggers',
  handler: async (_input, context) => {
    const triggers = await listEventTriggers(context.workerId);
    if (triggers.length === 0) {
      return 'No event triggers are configured for this session.';
    }
    const lines = triggers.map((t) => {
      const typeInfo = t.type === 'schedule' ? `schedule: ${t.scheduleExpression}` : `event-pattern: ${t.eventPattern}`;
      const idleNotify = t.idleNotifyAfter ? `, idle notify: ${t.idleNotifyAfter}` : '';
      return `- [${t.SK}] "${t.name}" (${typeInfo}${idleNotify}): "${t.message}"`;
    });
    return `Event triggers for this session:\n${lines.join('\n')}`;
  },
  schema: listInputSchema,
  toolSpec: async () => ({
    name: 'listEventTriggers',
    description: 'List all EventBridge event triggers configured for this session.',
    inputSchema: {
      json: zodToJsonSchemaBody(listInputSchema),
    },
  }),
};

// --- deleteEventTrigger ---

const deleteInputSchema = z.object({
  id: z
    .string()
    .describe('The ID of the event trigger to delete (returned by createEventTrigger or listEventTriggers).'),
});

export const deleteEventTriggerTool: ToolDefinition<z.infer<typeof deleteInputSchema>> = {
  name: 'deleteEventTrigger',
  handler: async (input, context) => {
    await deleteEventTrigger(context.workerId, input.id);
    return `Event trigger "${input.id}" has been deleted.`;
  },
  schema: deleteInputSchema,
  toolSpec: async () => ({
    name: 'deleteEventTrigger',
    description: 'Delete an EventBridge event trigger from this session by its ID.',
    inputSchema: {
      json: zodToJsonSchemaBody(deleteInputSchema),
    },
  }),
};
