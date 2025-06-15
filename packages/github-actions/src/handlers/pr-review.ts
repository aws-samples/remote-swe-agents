import * as core from '@actions/core';
import * as github from '@actions/github';
import { extractWorkerIdFromText } from '@remote-swe-agents/agent-core/lib';
import { ActionContext } from '../lib/context';
import { WebhookPayload } from '@actions/github/lib/interfaces';
import { getIssueComments, getIssueDescription, submitIssueComment } from '../lib/comments';
import { sendMessageToSession, startRemoteSweSession } from '../lib/remote-swe-api';
import { isCollaborator } from '../lib/permission';

export async function handlePrReviewEvent(context: ActionContext, payload: WebhookPayload): Promise<void> {
  const review = payload.review;
  if (!review) {
    core.info('No review found in payload, exiting');
    return;
  }

  const reviewBody = (review.body as string) || '';
  core.info(`Review body: ${reviewBody}`);

  // Skip if review body is empty
  if (!reviewBody.trim()) {
    core.info('Review body is empty, exiting');
    return;
  }

  // Check if reviewer is a collaborator
  const reviewer = review.user?.login;
  if (!reviewer) {
    core.info('Review author not found, exiting');
    return;
  }

  const repositoryName = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const hasPermission = await isCollaborator(reviewer, repositoryName);

  if (!hasPermission) {
    core.info(`Review author ${reviewer} does not have collaborator permissions, exiting`);
    return;
  }

  // Get PR number
  const prNumber = payload.pull_request?.number;
  if (!prNumber) {
    core.info('No PR number found, exiting');
    return;
  }

  // Get PR description to look for session ID
  const prDescription = await getIssueDescription(prNumber);
  if (!prDescription) {
    core.info('No PR description found, exiting');
    return;
  }

  // Extract worker ID from PR description
  const workerId = extractWorkerIdFromText(prDescription);
  if (!workerId) {
    core.info('No worker ID found in PR description, exiting');
    return;
  }

  // Prepare the message with review content
  const reviewState = review.state || 'Unknown';
  const message = `A new review has been submitted on PR #${prNumber} by ${reviewer} with status: ${reviewState}\n\n${reviewBody}\n\nThe above message was received from a GitHub pull request review. Please address the review comments.`;

  const sessionContext = {
    repository: github.context.repo,
    pullRequestUrl: payload.pull_request?.html_url,
    reviewId: review.id,
  };

  // Send the review to the existing session
  core.info(`Found existing workerId: ${workerId}, sending review to existing session`);
  await sendMessageToSession(workerId, message, sessionContext, context);

  core.info('Review message sent to worker successfully');
}
