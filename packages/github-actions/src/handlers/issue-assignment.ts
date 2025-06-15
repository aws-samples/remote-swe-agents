import * as core from '@actions/core';
import { startRemoteSweSession, RemoteSweApiConfig } from '../lib/remote-swe-api';
import { postSessionCommentToPrOrIssue } from '../lib/comments';
import { shouldTriggerForAssignee } from '../lib/trigger';
import { ActionContext } from '../lib/context';

export async function handleIssueAssignmentEvent(context: ActionContext, payload: any): Promise<void> {
  const assignee = payload.assignee?.login;

  // Check assignee trigger if specified
  if (!shouldTriggerForAssignee(context, [assignee])) {
    core.info(`Assignee trigger not matched for user: ${assignee}, exiting`);
    return;
  }

  if (!payload.issue) {
    core.info(`payload.issue is empty.`);
    return;
  }

  const message = `Please resolve this issue and create a pull request.
Issue URL: ${payload.issue.html_url}`;

  const sessionContext = {};

  const apiConfig: RemoteSweApiConfig = {
    apiBaseUrl: context.apiBaseUrl,
    apiKey: context.apiKey,
  };

  // Start remote-swe session
  core.info('Trigger conditions met, starting remote-swe session');
  const session = await startRemoteSweSession(message, sessionContext, apiConfig);

  // Post comment with session URL to the original PR/Issue
  await postSessionCommentToPrOrIssue(session.sessionId, session.sessionUrl, payload.issue.number);

  core.info('Remote-swe session started successfully');
}
