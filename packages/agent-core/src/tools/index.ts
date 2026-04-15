export * from './ci';
export * from './command-execution';
export * from './create-pr';
export * from './create-session';
export * from './editor';
export * from './event-trigger';
export * from './github-comments';
export * from './manage-agent';
export * from './repo';
export * from './report-progress';
export * from './send-file';
export * from './send-to-agent';
export * from './acknowledge-agent';
export * from './confirm-send-to-user';
export * from './think';
export * from './read-image';
export * from './todo';
export * from './session-title';

import { ciTool } from './ci';
import { commandExecutionTool } from './command-execution';
import { createPRTool } from './create-pr';
import { createNewSessionTool } from './create-session';
import { fileEditTool } from './editor';
import { createEventTriggerTool, listEventTriggersTool, deleteEventTriggerTool } from './event-trigger';
import { getPRCommentsTool, replyPRCommentTool, addIssueCommentTool } from './github-comments';
import { listAgentsTool, getAgentTool, createAgentTool, updateAgentTool, deleteAgentTool } from './manage-agent';
import { cloneRepositoryTool } from './repo';
import { reportProgressTool } from './report-progress';
import { sendFileTool } from './send-file';
import { sendToAgentTool } from './send-to-agent';
import { acknowledgeAgentTool } from './acknowledge-agent';
import { confirmSendToUserTool } from './confirm-send-to-user';
import { readImageTool } from './read-image';
import { todoInitTool, todoUpdateTool } from './todo';
import { updateSessionTitleTool } from './session-title';

/**
 * Tools that require GitHub configuration.
 * These are only available when GitHub App credentials are set up.
 */
export const gitHubTools = [
  ciTool,
  cloneRepositoryTool,
  createPRTool,
  getPRCommentsTool,
  replyPRCommentTool,
  addIssueCommentTool,
];

/**
 * Required tools that are always enabled regardless of custom agent tool selection.
 * These tools are essential for basic agent functionality.
 */
export const requiredTools = [
  reportProgressTool,
  todoInitTool,
  todoUpdateTool,
  sendFileTool,
  updateSessionTitleTool,
  confirmSendToUserTool,
];

/**
 * Required tool names for filtering convenience.
 */
export const requiredToolNames = requiredTools.map((tool) => tool.name);

/**
 * Optional tools that users can select in the custom agent configuration.
 * This includes all tools except required tools (which are always enabled).
 */
export const optionalTools = [
  ...gitHubTools,
  commandExecutionTool,
  fileEditTool,
  readImageTool,
  createNewSessionTool,
  sendToAgentTool,
  acknowledgeAgentTool,
  listAgentsTool,
  getAgentTool,
  createAgentTool,
  updateAgentTool,
  deleteAgentTool,
  createEventTriggerTool,
  listEventTriggersTool,
  deleteEventTriggerTool,
];

/**
 * All optional tool names (for use in custom agent forms and default agent config).
 */
export const allOptionalTools = optionalTools.map((tool) => tool.name);

/**
 * All available tools (both optional and required), used by the worker to build tool configs.
 */
export const allTools = [...optionalTools, ...requiredTools];
