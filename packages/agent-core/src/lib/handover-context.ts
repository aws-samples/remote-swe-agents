import { MessageItem } from '../schema';
import { TodoList } from '../schema/todo';

/**
 * Helpers for the webapp "Handover to New Session" feature.
 *
 * When a session becomes unresponsive, the user can hand its work over to a
 * fresh session in one action. The new session's seed message must carry
 * enough context (todo list, recent conversation, detected work state) for
 * the successor to continue without manual archaeology. Everything in this
 * module is a pure function so it can be unit-tested without AWS access.
 */

export interface DetectedWorkState {
  /** Git branch names, most recent mention first. */
  branches: string[];
  /** Pull request URLs, most recent mention first. */
  pullRequests: string[];
  /** Repository URLs (GitHub / CodeCommit), most recent mention first. */
  repositories: string[];
  /** Commit hashes, most recent mention first. */
  commits: string[];
}

export interface HandoverConversationMessage {
  role: 'user' | 'assistant';
  text: string;
}

const MAX_ITEMS_PER_CATEGORY = 3;

const BRANCH_PATTERNS = [
  /git checkout -b\s+['"`]?([\w./-]+)/g,
  /git switch -c\s+['"`]?([\w./-]+)/g,
  /git push(?:\s+(?:-u|--set-upstream))?\s+origin\s+['"`]?([\w./-]+)/g,
  /Switched to a new branch '([\w./-]+)'/g,
  /branch\s*[:：]\s*`?([\w./-]{3,})`?/gi,
  /branch\s+`([\w./-]{3,})`/gi,
  // Plain-text mention of a branch-like token (e.g. "working on
  // feature/foo-123"). Restricted to well-known branch prefixes and guarded
  // by a lookbehind so path segments inside URLs / file paths
  // (e.g. github.com/owner/feature/...) are not misdetected.
  /(?<![\w/.])((?:feature|fix|bugfix|hotfix|chore|release|refactor)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/g,
];

const PR_URL_PATTERN = /https:\/\/github\.com\/[\w-]+\/[\w.-]+\/pull\/\d+/g;
const GITHUB_REPO_PATTERN = /https:\/\/github\.com\/([\w-]+\/[\w.-]+)/g;
const CODECOMMIT_REPO_PATTERN = /https:\/\/git-codecommit\.[\w-]+\.amazonaws\.com\/v1\/repos\/[\w.-]+/g;
const COMMIT_PATTERN = /\bcommit\s+([0-9a-f]{7,40})\b/gi;

const stripTrailingPunctuation = (value: string) => value.replace(/[.,;:)]+$/, '');

const collectMatches = (texts: string[], pattern: RegExp, transform?: (m: string) => string): string[] => {
  const found: string[] = [];
  for (const text of texts) {
    // Reset lastIndex since the shared RegExp objects are sticky across calls (global flag).
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = stripTrailingPunctuation(match[1] ?? match[0]);
      if (!raw) continue;
      found.push(transform ? transform(raw) : raw);
    }
  }
  // Keep the most recent mention first, dropping duplicates.
  const unique: string[] = [];
  for (let i = found.length - 1; i >= 0; i--) {
    if (!unique.includes(found[i])) {
      unique.push(found[i]);
    }
  }
  return unique.slice(0, MAX_ITEMS_PER_CATEGORY);
};

/**
 * Best-effort extraction of the work state (branch / PR / repository /
 * commit) from free-form conversation and tool activity texts.
 * @param texts Texts ordered oldest → newest.
 */
export const extractWorkState = (texts: string[]): DetectedWorkState => {
  const branches: string[] = [];
  for (const pattern of BRANCH_PATTERNS) {
    for (const branch of collectMatches(texts, pattern)) {
      if (!branches.includes(branch)) {
        branches.push(branch);
      }
    }
  }

  const pullRequests = collectMatches(texts, PR_URL_PATTERN);
  const repositories = collectMatches(texts, GITHUB_REPO_PATTERN, (repo) => `https://github.com/${repo}`).concat(
    collectMatches(texts, CODECOMMIT_REPO_PATTERN)
  );
  const commits = collectMatches(texts, COMMIT_PATTERN);

  return {
    branches: branches.slice(0, MAX_ITEMS_PER_CATEGORY),
    pullRequests,
    repositories: repositories.slice(0, MAX_ITEMS_PER_CATEGORY),
    commits,
  };
};

const parseContentBlocks = (item: MessageItem): any[] => {
  try {
    const content = JSON.parse(item.content);
    return Array.isArray(content) ? content : [];
  } catch {
    return [];
  }
};

/**
 * Strips the LLM prompt envelope (`<user_message>` tags, `<command>` tail,
 * `[from: ...]` / `[Message from ...]` sender prefixes) so only the
 * human-meaningful body remains.
 */
export const stripPromptEnvelope = (text: string): string => {
  let body = text;
  const open = body.indexOf('<user_message>');
  const close = body.indexOf('</user_message>');
  if (open !== -1 && close !== -1 && close > open) {
    body = body.slice(open + '<user_message>'.length, close);
  }
  return body
    .replace(/^\s*\[from:[^\]]*\]\n?/, '')
    .replace(/^\s*\[Message from [^\]]+\]:\s*/, '')
    .trim();
};

const CONVERSATION_MESSAGE_TYPES = new Set(['userMessage', 'assistant', 'agentMessage']);

/**
 * Extracts the most recent user/assistant conversation texts from raw
 * DynamoDB message items (ordered oldest → newest).
 */
export const collectRecentConversation = (items: MessageItem[], maxMessages: number): HandoverConversationMessage[] => {
  const conversation: HandoverConversationMessage[] = [];
  for (const item of items) {
    if (!CONVERSATION_MESSAGE_TYPES.has(item.messageType)) continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    const text = parseContentBlocks(item)
      .map((block) => block?.text)
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
    const stripped = stripPromptEnvelope(text);
    if (!stripped) continue;
    conversation.push({ role: item.role, text: stripped });
  }
  return conversation.slice(-maxMessages);
};

/**
 * Collects every text-ish fragment (message text, tool inputs, tool result
 * texts) from the most recent items so `extractWorkState` can scan git
 * commands and their outputs, not just prose.
 */
export const collectWorkStateScanTexts = (items: MessageItem[], maxItems: number): string[] => {
  const texts: string[] = [];
  for (const item of items.slice(-maxItems)) {
    for (const block of parseContentBlocks(item)) {
      if (typeof block?.text === 'string') {
        texts.push(block.text);
      }
      if (block?.toolUse?.input != null) {
        try {
          texts.push(JSON.stringify(block.toolUse.input));
        } catch {
          // ignore non-serializable input
        }
      }
      for (const resultBlock of block?.toolResult?.content ?? []) {
        if (typeof resultBlock?.text === 'string') {
          texts.push(resultBlock.text);
        }
      }
    }
  }
  return texts;
};

const HANDOVER_TITLE_SUFFIX = ' (handover)';
const MAX_TITLE_LENGTH = 50;

/**
 * Builds the successor session's title so it is distinguishable from the old
 * session in list views. Returns undefined when the old session has no title
 * (letting the successor auto-generate one). Idempotent: an already-suffixed
 * title is returned unchanged so chained handovers do not stack suffixes.
 */
export const buildHandoverTitle = (oldTitle: string | undefined): string | undefined => {
  if (!oldTitle) return undefined;
  if (oldTitle.endsWith(HANDOVER_TITLE_SUFFIX)) return oldTitle;
  const base = oldTitle.slice(0, MAX_TITLE_LENGTH - HANDOVER_TITLE_SUFFIX.length);
  return `${base}${HANDOVER_TITLE_SUFFIX}`;
};

export interface BuildHandoverMessageParams {
  oldSessionId: string;
  todoList: TodoList | null;
  /** Recent conversation, oldest first. */
  recentMessages: HandoverConversationMessage[];
  workState: DetectedWorkState;
  /** Per-message character budget. Longer texts are head-truncated. */
  maxMessageChars?: number;
}

const DEFAULT_MAX_MESSAGE_CHARS = 500;

const truncate = (text: string, maxChars: number) =>
  text.length > maxChars ? `${text.slice(0, maxChars)}… (truncated)` : text;

/**
 * Builds the seed message for the successor session created by the webapp
 * handover action.
 */
export const buildHandoverMessage = (params: BuildHandoverMessageParams): string => {
  const { oldSessionId, todoList, recentMessages, workState, maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS } = params;

  const sections: string[] = [
    '[System: Session Handover]',
    `This session is continuing work from session ${oldSessionId} which became unresponsive.\nThe old session and its children have been reparented under this session.`,
  ];

  if (todoList && todoList.items.length > 0) {
    const todoLines = todoList.items.map((item) => `- [${item.status}] ${item.description}`);
    sections.push(`## Previous Todo List\n${todoLines.join('\n')}`);
  }

  if (recentMessages.length > 0) {
    const messageLines = recentMessages.map((m) => `[${m.role}] ${truncate(m.text, maxMessageChars)}`);
    sections.push(`## Last Messages (most recent context)\n${messageLines.join('\n\n')}`);
  }

  const workStateLines: string[] = [];
  if (workState.branches.length > 0) workStateLines.push(`- Branch: ${workState.branches.join(', ')}`);
  if (workState.pullRequests.length > 0) workStateLines.push(`- Pull Request: ${workState.pullRequests.join(', ')}`);
  if (workState.repositories.length > 0) workStateLines.push(`- Repository: ${workState.repositories.join(', ')}`);
  if (workState.commits.length > 0) workStateLines.push(`- Commit: ${workState.commits.join(', ')}`);
  workStateLines.push(
    "- Note: Any unpushed local changes may have been lost along with the old session's environment. Verify the remote state before continuing."
  );
  sections.push(`## Detected Work State (best-effort)\n${workStateLines.join('\n')}`);

  sections.push(
    `## Instructions\nContinue the work. Old session ${oldSessionId} is now your child; use searchSessions (scope: "tree") for additional context before asking the user.`
  );

  return sections.join('\n\n');
};
