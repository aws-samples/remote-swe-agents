import type { ToolDefinition } from '../private/common/lib';

import { createPRTool } from '../tools/create-pr';
import { createNewSessionTool } from '../tools/create-session';
import { createEventTriggerTool, listEventTriggersTool, deleteEventTriggerTool } from '../tools/event-trigger';
import { ciTool } from '../tools/ci';
import { getPRCommentsTool, replyPRCommentTool, addIssueCommentTool } from '../tools/github-comments';
import { listAgentsTool, getAgentTool, createAgentTool, updateAgentTool, deleteAgentTool } from '../tools/manage-agent';
import { listSkillsTool, getSkillTool, createSkillTool, updateSkillTool, deleteSkillTool } from '../tools/manage-skill';
import { cloneRepositoryTool } from '../tools/repo';
import { reportProgressTool } from '../tools/report-progress';
import { sendFileTool } from '../tools/send-file';
import { sendToAgentTool } from '../tools/send-to-agent';
import { acknowledgeAgentTool } from '../tools/acknowledge-agent';
import { confirmSendToUserTool } from '../tools/confirm-send-to-user';
import { todoInitTool, todoUpdateTool } from '../tools/todo';
import { updateSessionTitleTool } from '../tools/session-title';
import { thinkTool } from '../tools/think';
import { waitForConditionTool } from '../tools/wait-for';
import { completeSessionTool } from '../tools/complete-session';
import { confirmCompleteSessionTool } from '../tools/confirm-complete-session';
import { listSessionsTool } from '../tools/list-sessions';
import { reparentSessionTool } from '../tools/reparent-session';
import { exportSessionDiagnosticsTool } from '../tools/export-session-diagnostics';

/**
 * Tools exposed to Kiro sessions as an MCP server.
 *
 * Explicitly excluded because kiro-cli already ships equivalents:
 *   - executeCommand (kiro-cli's execute_bash)
 *   - fileEdit (kiro-cli's fs_write_file)
 *   - readLocalImage (kiro-cli's read_image)
 *
 * Everything else in `agent-core/tools` is remote-swe-specific:
 *   - user / agent messaging (sendMessageToUser family, agent-to-agent)
 *   - repo / GitHub operations (cloneRepository, PR/CI/comments)
 *   - agent lifecycle (createAgent / updateAgent / …)
 *   - session lifecycle (createNewSession, completeSession/confirmCompleteSession, event triggers, todo, title)
 *   - UI-oriented helpers (sendFileToUser, confirmSendToUser, think)
 */
export const kiroExportedTools: ToolDefinition<unknown>[] = [
  // user-facing messaging / files
  reportProgressTool,
  confirmSendToUserTool,
  sendFileTool,
  // agent-to-agent
  sendToAgentTool,
  acknowledgeAgentTool,
  createNewSessionTool,
  // repo + GitHub
  cloneRepositoryTool,
  ciTool,
  createPRTool,
  getPRCommentsTool,
  replyPRCommentTool,
  addIssueCommentTool,
  // agent management
  listAgentsTool,
  getAgentTool,
  createAgentTool,
  updateAgentTool,
  deleteAgentTool,
  // skill management
  listSkillsTool,
  getSkillTool,
  createSkillTool,
  updateSkillTool,
  deleteSkillTool,
  // event triggers
  createEventTriggerTool,
  listEventTriggersTool,
  deleteEventTriggerTool,
  // workflow / state
  todoInitTool,
  todoUpdateTool,
  updateSessionTitleTool,
  thinkTool,
  // async waiting (no kiro-cli equivalent; replaces blocking sleep loops)
  waitForConditionTool,
  // session lifecycle
  completeSessionTool,
  confirmCompleteSessionTool,
  listSessionsTool,
  reparentSessionTool,
  exportSessionDiagnosticsTool,
] as unknown as ToolDefinition<unknown>[];

/** Tool names exposed over MCP. Used for tests / debugging. */
export const kiroExportedToolNames = kiroExportedTools.map((t) => t.name);
