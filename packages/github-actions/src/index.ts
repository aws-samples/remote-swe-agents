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

async function startRemoteSweSession(message: string, context: any, inputs: ActionInputs): Promise<void> {
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
      throw new Error(`API request failed with status ${response.status}: ${response.statusText}`);
    }

    const responseData = await response.json();
    core.info(`Remote SWE session started successfully: ${JSON.stringify(responseData)}`);
  } catch (error) {
    core.error(`Failed to start remote SWE session: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
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
      const commentBody = comment.body || '';

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

      message = commentBody;
      context = {
        repository: github.context.repo,
      };
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
    await startRemoteSweSession(message, context, inputs);

    core.info('Remote-swe session started successfully');
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run the action
run();
