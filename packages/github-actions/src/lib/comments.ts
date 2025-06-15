import * as core from '@actions/core';
import * as github from '@actions/github';
import { appendWorkerIdMetadata } from '@remote-swe-agents/agent-core/lib';

export async function submitIssueComment(workerId: string, sessionUrl: string, issueNumber: number): Promise<void> {
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const { owner, repo } = github.context.repo;

    let commentBody = `🤖 Remote SWE session has been started!\n\n**Session URL:** ${sessionUrl}\n\nYou can monitor the progress and interact with the session using the link above.`;
    commentBody = appendWorkerIdMetadata(commentBody, workerId);

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: commentBody,
    });

    core.info(`Posted session comment to issue/PR #${issueNumber}`);
  } catch (error) {
    core.error(`Failed to post session comment: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get all the comments in an issue or pull request.
 * @param issueNumber issueId or pullRequestId
 */
export async function getIssueComments(issueNumber: number) {
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

/**
 * Get a description of an issue or pull request.
 * @param issueNumber issueId or pullRequestId
 */
export async function getIssueDescription(issueNumber: number): Promise<string> {
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const { owner, repo } = github.context.repo;

    const response = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    return response.data.body ?? '';
  } catch (error) {
    core.error(`Failed to get issue/PR description: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

export async function addEyesReactionToComment(commentId: number) {
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
