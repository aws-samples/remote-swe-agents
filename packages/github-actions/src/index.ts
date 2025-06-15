import * as core from '@actions/core';
import * as github from '@actions/github';
import { addIssueCommentTool } from '@remote-swe-agents/agent-core/tools';

async function isCollaborator(user: string, repository: string): Promise<boolean> {
  const [owner, repo] = repository.split('/');
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const res = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: user,
    });
    return ['admin', 'write'].includes(res.data.permission);
  } catch (e) {
    core.info(`got error on isCollaborator ${e}. owner: ${owner} repo: ${repo} user: ${user}`);
    return false;
  }
}

interface ActionInputs {
  triggerPhrase: string;
  assigneeTrigger?: string;
  apiBaseUrl: string;
  apiKey: string;
}

function getInputs(): ActionInputs {
  return {
    triggerPhrase: core.getInput('trigger_phrase', { required: true }),
    assigneeTrigger: core.getInput('assignee_trigger') || undefined,
    apiBaseUrl: core.getInput('api_base_url', { required: true }),
    apiKey: core.getInput('api_key', { required: true }),
  };
}

function shouldTriggerAction(comment: string, inputs: ActionInputs): boolean {
  return comment.includes(inputs.triggerPhrase);
}

function shouldTriggerForAssignee(assignees: string[], inputs: ActionInputs): boolean {
  // If no assignee trigger is specified, do nothing
  if (!inputs.assigneeTrigger) {
    return false;
  }

  // If assignee trigger is specified, only allow the specified assignee
  const targetAssignee = inputs.assigneeTrigger.replace('@', '');
  return assignees.some((assignee) => assignee === targetAssignee);
}

async function startRemoteSweSession(message: string, context: any, inputs: ActionInputs) {
  const baseUrl = inputs.apiBaseUrl.endsWith('/') ? inputs.apiBaseUrl.slice(0, -1) : inputs.apiBaseUrl;
  const apiUrl = `${baseUrl}/api/sessions`;

  if (context) {
    message += `\n\n Here is the additional context:\n${JSON.stringify(context, null, 1)}`;
  }
  const payload = {
    message,
  };

  try {
    core.info(`Making API call to: ${apiUrl}`);
    core.info(`Payload: ${JSON.stringify(payload, null, 2)}`);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': inputs.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}: ${response.status}`);
    }

    const responseData = await response.json();
    core.info(`Remote SWE session started successfully: ${JSON.stringify(responseData)}`);
    const sessionId = responseData.sessionId as string;
    return { sessionId, sessionUrl: `${baseUrl}/sessions/${sessionId}` };
  } catch (error) {
    core.error(`Failed to start remote SWE session: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function sendMessageToSession(sessionId: string, message: string, context: any, inputs: ActionInputs) {
  const baseUrl = inputs.apiBaseUrl.endsWith('/') ? inputs.apiBaseUrl.slice(0, -1) : inputs.apiBaseUrl;
  const apiUrl = `${baseUrl}/api/sessions/${sessionId}`;

  if (context) {
    message += `\n\n Here is the additional context:\n${JSON.stringify(context, null, 1)}`;
  }

  const payload = {
    message,
  };

  try {
    core.info(`Sending message to existing session: ${apiUrl}`);
    core.info(`Payload: ${JSON.stringify(payload, null, 2)}`);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': inputs.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}: ${response.statusText}`);
    }

    const responseData = await response.json();
    core.info(`Message sent successfully: ${JSON.stringify(responseData)}`);
    return responseData;
  } catch (error) {
    core.error(`Failed to send message to session: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

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

function extractWorkerIdFromComment(commentBody: string): string | null {
  const match = commentBody.match(/<!-- WORKER_ID:([^-]+) -->/);
  return match ? match[1] : null;
}

async function postSessionCommentToPrOrIssue(sessionUrl: string, eventName: string, payload: any): Promise<void> {
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const { owner, repo } = github.context.repo;

    const commentBody = `🤖 Remote SWE session has been started!\n\n**Session URL:** ${sessionUrl}\n\nYou can monitor the progress and interact with the session using the link above.`;

    if (eventName === 'issue_comment' && payload.issue) {
      // Comment on issue
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: payload.issue.number,
        body: commentBody,
      });
      core.info(`Posted session comment to issue #${payload.issue.number}`);
    } else if (eventName === 'pull_request_review_comment' && payload.pull_request) {
      // Comment on pull request
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: payload.pull_request.number,
        body: commentBody,
      });
      core.info(`Posted session comment to PR #${payload.pull_request.number}`);
    } else if (eventName === 'issues' && payload.issue) {
      // Comment on assigned issue
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: payload.issue.number,
        body: commentBody,
      });
      core.info(`Posted session comment to assigned issue #${payload.issue.number}`);
    } else if (eventName === 'pull_request' && payload.pull_request) {
      // Comment on assigned pull request
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: payload.pull_request.number,
        body: commentBody,
      });
      core.info(`Posted session comment to assigned PR #${payload.pull_request.number}`);
    } else {
      core.info('Unable to determine where to post session comment');
    }
  } catch (error) {
    core.error(`Failed to post session comment: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const payload = github.context.payload;
    const eventName = github.context.eventName;

    core.info(`Action triggered with event: ${eventName}`);

    let message = '';
    let context: any = {};

    if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') {
      // Handle comment events
      if (!payload.comment) {
        core.info('No comment found in payload, exiting');
        return;
      }

      const comment = payload.comment;
      const commentBody = (comment.body as string) || '';

      core.info(`Comment body: ${commentBody}`);

      // Check if comment contains trigger phrase
      if (!shouldTriggerAction(commentBody, inputs)) {
        core.info(`Comment does not contain trigger phrase "${inputs.triggerPhrase}", exiting`);
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

      // Get all comments and PR/issue description to check for existing workerId
      const allComments = await getIssueOrPRComments(issueNumber);
      const description = await getIssueOrPRDescription(issueNumber);
      let existingWorkerId: string | null = null;

      if (!existingWorkerId) {
        for (const existingComment of allComments) {
          const workerId = extractWorkerIdFromComment(existingComment.body);
          if (workerId) {
            existingWorkerId = workerId;
            break;
          }
        }
      }

      // If not found in comments, check description
      if (!existingWorkerId && description) {
        existingWorkerId = extractWorkerIdFromComment(description);
      }

      message = commentBody.replaceAll(inputs.triggerPhrase, '');
      context = {
        repository: github.context.repo,
        ...(payload.issue?.html_url ? { issueUrl: payload.issue.html_url } : {}),
        ...(payload.pull_request?.html_url ? { pullRequestUrl: payload.pull_request.html_url } : {}),
      };

      // If existing workerId found, send message to existing session instead of creating new one
      if (existingWorkerId) {
        core.info(`Found existing workerId: ${existingWorkerId}, sending message to existing session`);
        await addEyesReactionToComment(comment.id);
        await sendMessageToSession(existingWorkerId, message, context, inputs);
        return;
      }
    } else if (eventName === 'issues' && payload.action === 'assigned') {
      // Handle issue assignment
      const assignee = payload.assignee?.login;

      // Check assignee trigger if specified
      if (!shouldTriggerForAssignee([assignee], inputs)) {
        core.info(`Assignee trigger not matched for user: ${assignee}, exiting`);
        return;
      }

      if (!payload.issue) {
        core.info(`payload.issue is empty.`);
        return;
      }

      message = `Please resolve this issue and create a pull request.
Issue URL: ${payload.issue.html_url}`;
    } else if (eventName === 'pull_request' && payload.action === 'assigned') {
      // Handle PR assignment
      const assignee = payload.assignee?.login;

      // Check assignee trigger if specified
      if (!shouldTriggerForAssignee([assignee], inputs)) {
        core.info(`Assignee trigger not matched for user: ${assignee}, exiting`);
        return;
      }

      if (!payload.pull_request) {
        core.info(`payload.pull_request is empty.`);
        return;
      }

      message = `Please review this pull request and provide feedback or comments. When providing feedback, use ${addIssueCommentTool.name} tool to directly submit comments to the PR.

PR URL: ${payload.pull_request.html_url}`;
    } else {
      core.info(`Unsupported event: ${eventName} with action: ${payload.action}`);
      return;
    }

    core.info('Trigger conditions met, starting remote-swe session');

    // Start remote-swe session
    const sessionResult = await startRemoteSweSession(message, context, inputs);

    // Post comment with session URL to the original PR/Issue
    await postSessionCommentToPrOrIssue(sessionResult.sessionUrl, eventName, payload);

    core.info('Remote-swe session started successfully');
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run the action
run();
