import * as core from '@actions/core';
import { addIssueCommentTool } from '@remote-swe-agents/agent-core/tools';
import { startRemoteSweSession, RemoteSweApiConfig } from '../lib/remote-swe-api';
import { submitIssueComment } from '../lib/comments';
import { shouldTriggerForAssignee } from '../lib/trigger';
import { ActionContext } from '../lib/context';
import { WebhookPayload } from '@actions/github/lib/interfaces';

export async function handlePrAssignmentEvent(context: ActionContext, payload: WebhookPayload): Promise<void> {
  const assignee = payload.assignee?.login;

  // Check assignee trigger if specified
  if (!shouldTriggerForAssignee(context, [assignee])) {
    core.info(`Assignee trigger not matched for user: ${assignee}, exiting`);
    return;
  }

  if (!payload.pull_request) {
    core.info(`payload.pull_request is empty.`);
    return;
  }

  const message = `Please review this pull request and provide feedback or comments. 

  Use GitHub CLI to check the pull request detail. When providing feedback, use ${addIssueCommentTool.name} tool to directly submit comments to the PR.

PR URL: ${payload.pull_request.html_url}`.trim();

  const sessionContext = {};

  // Start remote-swe session
  core.info('Trigger conditions met, starting remote-swe session');
  const session = await startRemoteSweSession(message, sessionContext, context);

  // Post comment with session URL to the original PR/Issue
  await submitIssueComment(session.sessionId, session.sessionUrl, payload.pull_request.number);

  core.info('Remote-swe session started successfully');
}
