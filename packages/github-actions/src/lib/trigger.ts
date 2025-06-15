import { ActionContext } from './context';

export function shouldTriggerAction(context: ActionContext, comment: string): boolean {
  return comment.includes(context.triggerPhrase);
}

export function shouldTriggerForAssignee(context: ActionContext, assignees: string[]): boolean {
  // If no assignee trigger is specified, do nothing
  if (!context.assigneeTrigger) {
    return false;
  }

  // If assignee trigger is specified, only allow the specified assignee
  const targetAssignee = context.assigneeTrigger.replace('@', '');
  return assignees.some((assignee) => assignee === targetAssignee);
}
