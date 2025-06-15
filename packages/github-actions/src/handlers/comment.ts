import * as core from '@actions/core';
import * as github from '@actions/github';
import { extractWorkerIdFromText } from '@remote-swe-agents/agent-core/lib';
import { isCollaborator } from '../lib/permission';
import { startRemoteSweSession, sendMessageToSession, RemoteSweApiConfig } from '../lib/remote-swe-api';
import { postSessionCommentToPrOrIssue } from '../lib/comments';
import { shouldTriggerAction } from '../lib/trigger';
import { ActionContext } from '../lib/context';

async function getIssueOrPRComments(issueNumber: number): Promise<any[]> {
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const { owner, repo } = github.context.repo;

    const response = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      sort: 'created',
      direction: 'desc',
    });

    return response.data;
  } catch (error) {
    core.error(`Failed to get comments: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function getIssueOrPRDescription(issueNumber: number): Promise<string | null> {
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const { owner, repo } = github.context.repo;

    const response = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    return response.data.body || null;
  } catch (error) {
    core.error(`Failed to get issue/PR description: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function addEyesReactionToComment(commentId: number) {
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const { owner, repo } = github.context.repo;

    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: 'eyes',
    });

    core.info(`Added eyes reaction to comment ${commentId}`);
  } catch (error) {
    core.error(`Failed to add eyes reaction: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function handleCommentEvent(context: ActionContext, payload: any): Promise<void> {
  if (!payload.comment) {
    core.info('No comment found in payload, exiting');
    return;
  }

  const comment = payload.comment;
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

  let existingWorkerId: string | null = null;

  // Get all comments and PR/issue description to check for existing workerId
  const allComments = await getIssueOrPRComments(issueNumber);
  for (const existingComment of allComments) {
    const workerId = extractWorkerIdFromText(existingComment.body);
    if (workerId) {
      existingWorkerId = workerId;
      break;
    }
  }

  // If not found in comments, check description
  if (!existingWorkerId) {
    const description = await getIssueOrPRDescription(issueNumber);
    if (description) {
      existingWorkerId = extractWorkerIdFromText(description);
    }
  }

  const message = commentBody.replaceAll(context.triggerPhrase, '');
  const sessionContext = {
    repository: github.context.repo,
    ...(payload.issue?.html_url ? { issueUrl: payload.issue.html_url } : {}),
    ...(payload.pull_request?.html_url ? { pullRequestUrl: payload.pull_request.html_url } : {}),
  };

  const apiConfig: RemoteSweApiConfig = {
    apiBaseUrl: context.apiBaseUrl,
    apiKey: context.apiKey,
  };

  // If existing workerId found, send message to existing session instead of creating new one
  if (existingWorkerId) {
    core.info(`Found existing workerId: ${existingWorkerId}, sending message to existing session`);
    await addEyesReactionToComment(comment.id);
    await sendMessageToSession(existingWorkerId, message, sessionContext, apiConfig);
    return;
  }

  // Start new remote-swe session
  core.info('Trigger conditions met, starting remote-swe session');
  const session = await startRemoteSweSession(message, sessionContext, apiConfig);

  // Post comment with session URL to the original PR/Issue
  await postSessionCommentToPrOrIssue(session.sessionId, session.sessionUrl, issueNumber);

  core.info('Remote-swe session started successfully');
}
