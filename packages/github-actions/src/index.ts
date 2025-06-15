import * as core from '@actions/core';
import * as github from '@actions/github';
import { handleIssueAssignmentEvent } from './handlers/issue-assignment';
import { handlePrAssignmentEvent } from './handlers/pr-assignment';
import { ActionContext } from './lib/context';
import { handleCommentEvent } from './handlers/comment';
import { handlePrReviewEvent } from './handlers/pr-review';

function getContext(): ActionContext {
  return {
    triggerPhrase: core.getInput('trigger_phrase', { required: true }),
    assigneeTrigger: core.getInput('assignee_trigger') || undefined,
    apiBaseUrl: core.getInput('api_base_url', { required: true }),
    apiKey: core.getInput('api_key', { required: true }),
  };
}

async function run() {
  try {
    const context = getContext();

    // see https://docs.github.com/en/webhooks/webhook-events-and-payloads
    const payload = github.context.payload;
    const eventName = github.context.eventName;

    core.info(`Action triggered with event: ${eventName}`);

    if (eventName === 'issue_comment') {
      await handleCommentEvent(context, payload);
    } else if (eventName === 'pull_request_review_comment') {
      await handleCommentEvent(context, payload);
    } else if (eventName === 'pull_request_review') {
      await handlePrReviewEvent(context, payload);
    } else if (eventName === 'issues' && payload.action === 'assigned') {
      await handleIssueAssignmentEvent(context, payload);
    } else if (eventName === 'pull_request' && payload.action === 'assigned') {
      await handlePrAssignmentEvent(context, payload);
    } else {
      core.info(`Unsupported event: ${eventName} with action: ${payload.action}`);
      return;
    }
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run the action
run();
