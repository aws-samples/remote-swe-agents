import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  FlexibleTimeWindowMode,
  ActionAfterCompletion,
} from '@aws-sdk/client-scheduler';
import {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
  DeleteRuleCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import { PutCommand, QueryCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws/ddb';

const scheduler = new SchedulerClient({});
const eventBridge = new EventBridgeClient({});

const RESOURCE_PREFIX = process.env.EVENT_TRIGGER_RESOURCE_PREFIX ?? 'remote-swe';
const MAX_TRIGGERS_PER_SESSION = 10;

function parseRelativeTimeToIso(expr: string): string {
  const ms = parseRelativeTimeToMs(expr);
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, '');
}

function parseRelativeTimeToMs(expr: string): number {
  const match = expr.match(/^(\d+)\s*(s|sec|min|m|h|hr|d)$/i);
  if (!match) throw new Error(`Invalid relative time expression: ${expr}`);
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === 's' || unit === 'sec') return value * 1000;
  if (unit === 'min' || unit === 'm') return value * 60 * 1000;
  if (unit === 'h' || unit === 'hr') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  return 0;
}

function generateTriggerId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface EventTriggerItem {
  PK: `event-trigger-${string}`;
  SK: string;
  workerId: string;
  name: string;
  type: 'schedule' | 'event-pattern';
  scheduleExpression?: string;
  eventPattern?: string;
  message: string;
  resourceName: string;
  ttlScheduleName?: string;
  idleNotifyAfter?: string;
  idleNotifyMs?: number;
  ttlSfnArn?: string;
  ttlSfnRoleArn?: string;
  createdAt: number;
}

function makeResourceName(workerId: string, triggerName: string): string {
  const maxLen = 64;
  const prefix = RESOURCE_PREFIX;
  // prefix + '-' + workerId + '-' + triggerName
  const overhead = prefix.length + 1 + 1 + triggerName.length;
  const maxWorkerIdLen = maxLen - overhead;
  const truncatedWorkerId = workerId.slice(0, Math.max(maxWorkerIdLen, 8));
  return `${prefix}-${truncatedWorkerId}-${triggerName}`;
}

function makeTtlScheduleName(workerId: string, triggerName: string): string {
  const maxLen = 64;
  const prefix = `${RESOURCE_PREFIX}-ttl`;
  const overhead = prefix.length + 1 + 1 + triggerName.length;
  const maxWorkerIdLen = maxLen - overhead;
  const truncatedWorkerId = workerId.slice(0, Math.max(maxWorkerIdLen, 8));
  return `${prefix}-${truncatedWorkerId}-${triggerName}`;
}

export async function getEventTrigger(workerId: string, triggerName: string): Promise<EventTriggerItem | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: `event-trigger-${workerId}`,
        SK: triggerName,
      },
    })
  );
  return result.Item as EventTriggerItem | undefined;
}

export async function listEventTriggers(workerId: string): Promise<EventTriggerItem[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `event-trigger-${workerId}`,
      },
    })
  );
  return (result.Items ?? []) as EventTriggerItem[];
}

export async function countEventTriggers(workerId: string): Promise<number> {
  const result = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `event-trigger-${workerId}`,
      },
      Select: 'COUNT',
    })
  );
  return result.Count ?? 0;
}

export interface CreateScheduleTriggerParams {
  workerId: string;
  name: string;
  scheduleExpression: string;
  message: string;
  sfnArn: string;
  sfnRoleArn: string;
}

export async function createScheduleTrigger(params: CreateScheduleTriggerParams): Promise<EventTriggerItem> {
  const { workerId, name, scheduleExpression, message, sfnArn, sfnRoleArn } = params;

  await validateTriggerLimit(workerId);

  const triggerId = generateTriggerId();
  const resourceName = makeResourceName(workerId, triggerId);
  const isOneTime = scheduleExpression.startsWith('at(');

  await scheduler.send(
    new CreateScheduleCommand({
      Name: resourceName,
      ScheduleExpression: scheduleExpression,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      Target: {
        Arn: sfnArn,
        RoleArn: sfnRoleArn,
        Input: JSON.stringify({
          workerId,
          triggerName: triggerId,
          eventDetails: {},
          agentRuntimeArn: process.env.AGENT_RUNTIME_ARN ?? '',
        }),
      },
      ...(isOneTime ? { ActionAfterCompletion: ActionAfterCompletion.DELETE } : {}),
    })
  );

  const item: EventTriggerItem = {
    PK: `event-trigger-${workerId}`,
    SK: triggerId,
    workerId,
    name,
    type: 'schedule',
    scheduleExpression,
    message,
    resourceName,
    createdAt: Date.now(),
  };

  await ddb.send(new PutCommand({ TableName, Item: item }));
  return item;
}

export interface CreateEventPatternTriggerParams {
  workerId: string;
  name: string;
  eventPattern: Record<string, any>;
  message: string;
  idleNotifyAfter?: string;
  sfnArn: string;
  sfnRoleArn: string;
  ttlSfnArn: string;
  ttlSfnRoleArn: string;
}

export async function createEventPatternTrigger(params: CreateEventPatternTriggerParams): Promise<EventTriggerItem> {
  const { workerId, name, eventPattern, message, idleNotifyAfter, sfnArn, sfnRoleArn, ttlSfnArn, ttlSfnRoleArn } =
    params;

  await validateTriggerLimit(workerId);

  const triggerId = generateTriggerId();
  const resourceName = makeResourceName(workerId, triggerId);

  await eventBridge.send(
    new PutRuleCommand({
      Name: resourceName,
      EventPattern: JSON.stringify(eventPattern),
      State: 'ENABLED',
    })
  );

  await eventBridge.send(
    new PutTargetsCommand({
      Rule: resourceName,
      Targets: [
        {
          Id: 'sfn-target',
          Arn: sfnArn,
          RoleArn: sfnRoleArn,
          InputTransformer: {
            InputPathsMap: {
              detail: '$.detail',
              source: '$.source',
              'detail-type': '$.detail-type',
            },
            InputTemplate: `{"workerId":"${workerId}","triggerName":"${triggerId}","agentRuntimeArn":"${process.env.AGENT_RUNTIME_ARN ?? ''}","eventDetails":{"source":<source>,"detail-type":<detail-type>,"detail":<detail>}}`,
          },
        },
      ],
    })
  );

  let ttlScheduleName: string | undefined;
  if (idleNotifyAfter) {
    const notifyAt = parseRelativeTimeToIso(idleNotifyAfter);
    ttlScheduleName = makeTtlScheduleName(workerId, triggerId);
    await scheduler.send(
      new CreateScheduleCommand({
        Name: ttlScheduleName,
        ScheduleExpression: `at(${notifyAt})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        ActionAfterCompletion: ActionAfterCompletion.DELETE,
        Target: {
          Arn: ttlSfnArn,
          RoleArn: ttlSfnRoleArn,
          Input: JSON.stringify({
            workerId,
            triggerName: triggerId,
            agentRuntimeArn: process.env.AGENT_RUNTIME_ARN ?? '',
          }),
        },
      })
    );
  }

  const item: EventTriggerItem = {
    PK: `event-trigger-${workerId}`,
    SK: triggerId,
    workerId,
    name,
    type: 'event-pattern',
    eventPattern: JSON.stringify(eventPattern),
    message,
    resourceName,
    ttlScheduleName,
    idleNotifyAfter,
    idleNotifyMs: idleNotifyAfter ? parseRelativeTimeToMs(idleNotifyAfter) : undefined,
    ttlSfnArn: ttlSfnArn || undefined,
    ttlSfnRoleArn: ttlSfnRoleArn || undefined,
    createdAt: Date.now(),
  };

  await ddb.send(new PutCommand({ TableName, Item: item }));
  return item;
}

export async function deleteEventTrigger(workerId: string, triggerId: string): Promise<void> {
  const item = await getEventTrigger(workerId, triggerId);
  if (!item) return;

  await deleteEventTriggerResources(item);

  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: {
        PK: `event-trigger-${workerId}`,
        SK: triggerId,
      },
    })
  );
}

async function deleteEventTriggerResources(item: EventTriggerItem): Promise<void> {
  if (item.type === 'schedule') {
    try {
      await scheduler.send(new DeleteScheduleCommand({ Name: item.resourceName }));
    } catch (e: any) {
      if (e.name !== 'ResourceNotFoundException') {
        console.error(`Failed to delete schedule ${item.resourceName}:`, e);
      }
    }
  } else if (item.type === 'event-pattern') {
    try {
      await eventBridge.send(
        new RemoveTargetsCommand({
          Rule: item.resourceName,
          Ids: ['sfn-target'],
        })
      );
    } catch (e: any) {
      if (e.name !== 'ResourceNotFoundException') {
        console.error(`Failed to remove targets from rule ${item.resourceName}:`, e);
      }
    }
    try {
      await eventBridge.send(new DeleteRuleCommand({ Name: item.resourceName }));
    } catch (e: any) {
      if (e.name !== 'ResourceNotFoundException') {
        console.error(`Failed to delete rule ${item.resourceName}:`, e);
      }
    }
    if (item.ttlScheduleName) {
      try {
        await scheduler.send(new DeleteScheduleCommand({ Name: item.ttlScheduleName }));
      } catch (e: any) {
        if (e.name !== 'ResourceNotFoundException') {
          console.error(`Failed to delete TTL schedule ${item.ttlScheduleName}:`, e);
        }
      }
    }
  }
}

export async function deleteAllEventTriggers(workerId: string): Promise<void> {
  const triggers = await listEventTriggers(workerId);
  await Promise.allSettled(
    triggers.map(async (trigger) => {
      await deleteEventTriggerResources(trigger);
      await ddb.send(
        new DeleteCommand({
          TableName,
          Key: {
            PK: `event-trigger-${workerId}`,
            SK: trigger.SK,
          },
        })
      );
    })
  );
}

async function validateTriggerLimit(workerId: string): Promise<void> {
  const count = await countEventTriggers(workerId);
  if (count >= MAX_TRIGGERS_PER_SESSION) {
    throw new Error(
      `Maximum number of event triggers (${MAX_TRIGGERS_PER_SESSION}) reached for this session. Delete existing triggers before creating new ones.`
    );
  }
}
