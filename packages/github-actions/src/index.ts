import * as core from '@actions/core';
import * as github from '@actions/github';

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
  const payload = {
    message: `${message}\n\n${JSON.stringify(context, null, 2)}`,
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

      message = commentBody;
      context = {
        repository: github.context.repo,
        issue: payload.issue || payload.pull_request,
        comment: {
          id: comment.id,
          body: commentBody,
          user: comment.user?.login,
          created_at: comment.created_at,
        },
        trigger_phrase: inputs.triggerPhrase,
        event_type: 'comment',
      };
    } else if (eventName === 'issues' && payload.action === 'assigned') {
      // Handle issue assignment
      const assignee = payload.assignee?.login;

      // Check assignee trigger if specified
      if (!shouldTriggerForAssignee([assignee], inputs)) {
        core.info(`Assignee trigger not matched for user: ${assignee}, exiting`);
        return;
      }

      message = `Please resolve this issue and create a pull request.

Issue URL: ${payload.issue?.html_url}
Issue Title: ${payload.issue?.title}
Issue Description: ${payload.issue?.body || 'No description provided'}`;

      context = {
        repository: github.context.repo,
        issue: payload.issue,
        assignee: assignee,
        event_type: 'issue_assigned',
      };
    } else if (eventName === 'pull_request' && payload.action === 'assigned') {
      // Handle PR assignment
      const assignee = payload.assignee?.login;

      // Check assignee trigger if specified
      if (!shouldTriggerForAssignee([assignee], inputs)) {
        core.info(`Assignee trigger not matched for user: ${assignee}, exiting`);
        return;
      }

      message = `Please review this pull request and provide feedback or comments.

PR URL: ${payload.pull_request?.html_url}
PR Title: ${payload.pull_request?.title}
PR Description: ${payload.pull_request?.body || 'No description provided'}`;

      context = {
        repository: github.context.repo,
        pull_request: payload.pull_request,
        assignee: assignee,
        event_type: 'pr_assigned',
      };
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
