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
  if (!inputs.assigneeTrigger) {
    return true;
  }

  const targetAssignee = inputs.assigneeTrigger.replace('@', '');
  return assignees.some((assignee) => assignee === targetAssignee);
}

async function startRemoteSweSession(message: string, context: any, inputs: ActionInputs): Promise<void> {
  const apiUrl = `${inputs.apiBaseUrl}/api/sessions`;
  const payload = {
    message: `${message}\n\n${JSON.stringify(context, null, 2)}`
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

    core.info(`Action triggered with phrase: "${inputs.triggerPhrase}"`);

    // Check if this is a comment on an issue or pull request
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

    // Check assignee trigger if specified
    let assignees: string[] = [];
    if (payload.issue) {
      assignees = payload.issue.assignees?.map((assignee: any) => assignee.login) || [];
    } else if (payload.pull_request) {
      assignees = payload.pull_request.assignees?.map((assignee: any) => assignee.login) || [];
    }

    if (!shouldTriggerForAssignee(assignees, inputs)) {
      core.info(`Assignee trigger not matched, exiting`);
      return;
    }

    // Extract context information
    const context = {
      repository: github.context.repo,
      issue: payload.issue || payload.pull_request,
      comment: {
        id: comment.id,
        body: commentBody,
        user: comment.user?.login,
        created_at: comment.created_at,
      },
      trigger_phrase: inputs.triggerPhrase,
      assignees,
    };

    core.info('Trigger conditions met, starting remote-swe session');

    // Start remote-swe session
    await startRemoteSweSession(commentBody, context, inputs);

    core.info('Remote-swe session started successfully');
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run the action
run();
