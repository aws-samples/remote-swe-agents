import * as core from '@actions/core';
import * as github from '@actions/github';
import { appendWorkerIdMetadata } from '@remote-swe-agents/agent-core/lib';

export async function postSessionCommentToPrOrIssue(
  workerId: string,
  sessionUrl: string,
  issueOrPrId: number
): Promise<void> {
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const { owner, repo } = github.context.repo;

    let commentBody = `🤖 Remote SWE session has been started!\n\n**Session URL:** ${sessionUrl}\n\nYou can monitor the progress and interact with the session using the link above.`;
    commentBody = appendWorkerIdMetadata(commentBody, workerId);

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueOrPrId,
      body: commentBody,
    });

    core.info(`Posted session comment to issue/PR #${issueOrPrId}`);
  } catch (error) {
    core.error(`Failed to post session comment: ${error instanceof Error ? error.message : String(error)}`);
  }
}
