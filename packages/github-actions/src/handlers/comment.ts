import * as core from '@actions/core';
import * as github from '@actions/github';
import { extractWorkerIdFromText } from '@remote-swe-agents/agent-core/lib';
import { isCollaborator } from '../lib/permission';
import { startRemoteSweSession, sendMessageToSession } from '../lib/remote-swe-api';
import { addEyesReactionToComment, getIssueComments, getIssueDescription, submitIssueComment } from '../lib/comments';
import { shouldTriggerAction } from '../lib/trigger';
import { ActionContext } from '../lib/context';
import { WebhookPayload } from '@actions/github/lib/interfaces';

export async function handleCommentEvent(context: ActionContext, payload: WebhookPayload): Promise<void> {
  const comment = payload.comment;
  if (!comment) {
    core.info('No comment found in payload, exiting');
    return;
  }

  const commentBody = (comment.body as string) || '';

  core.info(`Comment body: ${commentBody}`);

  // Check if comment contains trigger phrase
  if (!shouldTriggerAction(context, commentBody)) {
    core.info(`Comment does not contain trigger phrase "${context.triggerPhrase}", exiting`);
    return;
  }

  // Check if comment author is a collaborator
  const commentAuthor = comment.user?.login;
  if (!commentAuthor) {
    core.info('Comment author not found, exiting');
    return;
  }

  const repositoryName = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const hasPermission = await isCollaborator(commentAuthor, repositoryName);

  if (!hasPermission) {
    core.info(`Comment author ${commentAuthor} does not have collaborator permissions, exiting`);
    return;
  }

  // Get issue/PR number
  const issueNumber = payload.issue?.number || payload.pull_request?.number;
  if (!issueNumber) {
    core.info('No issue or PR number found, exiting');
    return;
  }
  const source = payload.issue?.number ? 'issue' : 'pull request';

  let existingWorkerId: string | null = null;

  // Get all comments and PR/issue description to check for existing workerId
  const allComments = await getIssueComments(issueNumber);
  for (const comment of allComments) {
    const workerId = extractWorkerIdFromText(comment.body ?? '');
    if (workerId) {
      existingWorkerId = workerId;
      break;
    }
  }

  // If not found in comments, check description
  if (!existingWorkerId) {
    const description = await getIssueDescription(issueNumber);
    if (description) {
      existingWorkerId = extractWorkerIdFromText(description);
    }
  }

  let message = commentBody.replaceAll(context.triggerPhrase, '');
  const sessionContext = {
    repository: github.context.repo,
    ...(payload.issue?.html_url ? { issueUrl: payload.issue.html_url } : {}),
    ...(payload.pull_request?.html_url ? { pullRequestUrl: payload.pull_request.html_url } : {}),
    commentId: comment.id,
  };

  // If existing workerId found, send message to existing session instead of creating new one
  if (existingWorkerId) {
    core.info(`Found existing workerId: ${existingWorkerId}, sending message to existing session`);
    message += `\n\nThe above message was received from a GitHub ${source}. Please address the comment.`;
    await sendMessageToSession(existingWorkerId, message, sessionContext, context);
    await addEyesReactionToComment(comment.id);
  } else {
    // Start new remote-swe session
    core.info('Trigger conditions met, starting remote-swe session');

    message += `\n\nThe above message was received from a GitHub ${source}. Please use GitHub CLI to get the detail and address the comment.`;

    const session = await startRemoteSweSession(message, sessionContext, context);
    // Post comment with session URL to the original PR/Issue
    await submitIssueComment(session.sessionId, session.sessionUrl, issueNumber);
    core.info('Remote-swe session started successfully');
  }
}
