import { describe, expect, test } from 'vitest';
import {
  buildHandoverMessage,
  buildHandoverTitle,
  collectRecentConversation,
  collectWorkStateScanTexts,
  extractWorkState,
  stripPromptEnvelope,
} from './handover-context';
import { MessageItem } from '../schema';
import { TodoList } from '../schema/todo';

const makeItem = (partial: Partial<MessageItem> & { content: string }): MessageItem => ({
  PK: 'message-session-1',
  SK: '000000000000001',
  role: 'user',
  tokenCount: 0,
  messageType: 'userMessage',
  ...partial,
});

const textContent = (text: string) => JSON.stringify([{ text }]);

describe('extractWorkState', () => {
  test('detects branch from git checkout -b', () => {
    const state = extractWorkState(['I ran git checkout -b feature/session-handover-123 and started work']);
    expect(state.branches).toContain('feature/session-handover-123');
  });

  test('detects branch from git push origin', () => {
    const state = extractWorkState(['git push -u origin fix/login-bug-456']);
    expect(state.branches).toContain('fix/login-bug-456');
  });

  test('detects branch from "branch:" prose', () => {
    const state = extractWorkState(['Pushed. branch: `feature/awesome-1755`']);
    expect(state.branches).toContain('feature/awesome-1755');
  });

  // Uses CJK (Japanese) prose on purpose: verifies a branch name is extracted
  // even when embedded in non-English text with no git-command context.
  test('detects plain-text branch mentions without git command context (E2E-1)', () => {
    const state = extractWorkState(['feature/e2e-test-branch-handover というブランチで作業中です']);
    expect(state.branches).toContain('feature/e2e-test-branch-handover');
  });

  test('does not misdetect branch-prefix-like segments inside URLs', () => {
    const state = extractWorkState(['see https://github.com/owner/feature/blob/main/x.md for details']);
    expect(state.branches).toEqual([]);
  });

  test('detects PR URLs and their repository', () => {
    const state = extractWorkState(['Opened https://github.com/aws-samples/remote-swe-agents/pull/123 for review.']);
    expect(state.pullRequests).toEqual(['https://github.com/aws-samples/remote-swe-agents/pull/123']);
    expect(state.repositories).toContain('https://github.com/aws-samples/remote-swe-agents');
  });

  test('detects CodeCommit repository URLs', () => {
    const state = extractWorkState(['Cloned https://git-codecommit.us-east-1.amazonaws.com/v1/repos/example-repo.']);
    expect(state.repositories).toContain('https://git-codecommit.us-east-1.amazonaws.com/v1/repos/example-repo');
  });

  test('detects commit hashes only with commit context', () => {
    const state = extractWorkState(['Created commit abc1234def with the fix. Random hex deadbeefcafe elsewhere.']);
    expect(state.commits).toEqual(['abc1234def']);
  });

  test('returns most recent mentions first and dedupes', () => {
    const state = extractWorkState([
      'git checkout -b feature/first-1',
      'git checkout -b feature/second-2',
      'git push -u origin feature/second-2',
    ]);
    expect(state.branches[0]).toBe('feature/second-2');
    expect(state.branches.filter((b) => b === 'feature/second-2')).toHaveLength(1);
  });

  test('caps each category at 3 entries', () => {
    const texts = [1, 2, 3, 4, 5].map((i) => `git checkout -b feature/branch-${i}`);
    const state = extractWorkState(texts);
    expect(state.branches).toHaveLength(3);
    expect(state.branches[0]).toBe('feature/branch-5');
  });

  test('returns empty arrays when nothing is detected', () => {
    const state = extractWorkState(['just chatting about the weather']);
    expect(state.branches).toEqual([]);
    expect(state.pullRequests).toEqual([]);
    expect(state.repositories).toEqual([]);
    expect(state.commits).toEqual([]);
  });
});

describe('stripPromptEnvelope', () => {
  test('extracts body from user_message envelope and drops the command tail', () => {
    const raw = `<user_message>\n[from: alice (webapp)]\nfix the bug please\n</user_message>\n<command>\nUser sent you a message.\n</command>`;
    expect(stripPromptEnvelope(raw)).toBe('fix the bug please');
  });

  test('strips agent message prefix', () => {
    expect(stripPromptEnvelope('[Message from PM (session-1)]: do the thing')).toBe('do the thing');
  });

  test('returns plain text unchanged', () => {
    expect(stripPromptEnvelope('hello world')).toBe('hello world');
  });
});

describe('collectRecentConversation', () => {
  test('keeps only user/assistant conversation and applies the envelope strip', () => {
    const items: MessageItem[] = [
      makeItem({ content: textContent('<user_message>\nfirst request\n</user_message>'), messageType: 'userMessage' }),
      makeItem({ content: textContent('working on it'), role: 'assistant', messageType: 'assistant' }),
      makeItem({
        content: JSON.stringify([{ toolUse: { name: 'executeCommand', input: {} } }]),
        role: 'assistant',
        messageType: 'toolUse',
      }),
      makeItem({ content: textContent('[Message from PM (session-9)]: status?'), messageType: 'agentMessage' }),
    ];
    const conversation = collectRecentConversation(items, 10);
    expect(conversation).toEqual([
      { role: 'user', text: 'first request' },
      { role: 'assistant', text: 'working on it' },
      { role: 'user', text: 'status?' },
    ]);
  });

  test('returns only the last N messages', () => {
    const items = [1, 2, 3, 4, 5].map((i) => makeItem({ content: textContent(`message ${i}`) }));
    const conversation = collectRecentConversation(items, 2);
    expect(conversation.map((m) => m.text)).toEqual(['message 4', 'message 5']);
  });

  test('ignores unparsable content', () => {
    const items = [makeItem({ content: 'not-json' }), makeItem({ content: textContent('valid') })];
    expect(collectRecentConversation(items, 10)).toEqual([{ role: 'user', text: 'valid' }]);
  });
});

describe('collectWorkStateScanTexts', () => {
  test('includes message text, tool inputs and tool result texts', () => {
    const items: MessageItem[] = [
      makeItem({ content: textContent('pushed the branch') }),
      makeItem({
        content: JSON.stringify([
          { toolUse: { name: 'executeCommand', input: { command: 'git checkout -b feature/x-1' } } },
        ]),
        role: 'assistant',
        messageType: 'toolUse',
      }),
      makeItem({
        content: JSON.stringify([{ toolResult: { toolUseId: 't1', content: [{ text: 'commit abc1234 created' }] } }]),
        messageType: 'toolResult',
      }),
    ];
    const texts = collectWorkStateScanTexts(items, 50);
    expect(texts.some((t) => t.includes('pushed the branch'))).toBe(true);
    expect(texts.some((t) => t.includes('git checkout -b feature/x-1'))).toBe(true);
    expect(texts.some((t) => t.includes('commit abc1234'))).toBe(true);
  });

  test('respects the maxItems window', () => {
    const items = [1, 2, 3].map((i) => makeItem({ content: textContent(`text ${i}`) }));
    const texts = collectWorkStateScanTexts(items, 1);
    expect(texts).toEqual(['text 3']);
  });
});

describe('buildHandoverTitle', () => {
  test('appends the handover suffix', () => {
    expect(buildHandoverTitle('My Task')).toBe('My Task (handover)');
  });

  test('returns undefined when there is no title', () => {
    expect(buildHandoverTitle(undefined)).toBeUndefined();
    expect(buildHandoverTitle('')).toBeUndefined();
  });

  test('is idempotent for already-suffixed titles', () => {
    expect(buildHandoverTitle('My Task (handover)')).toBe('My Task (handover)');
  });

  test('keeps the result within the 50 character title limit', () => {
    const longTitle = 'x'.repeat(60);
    const result = buildHandoverTitle(longTitle)!;
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith(' (handover)')).toBe(true);
  });
});

describe('buildHandoverMessage', () => {
  const emptyWorkState = { branches: [], pullRequests: [], repositories: [], commits: [] };

  test('renders all sections when data is available', () => {
    const todoList: TodoList = {
      items: [
        { id: 'task-1', description: 'implement feature', status: 'completed', createdAt: 1, updatedAt: 1 },
        { id: 'task-2', description: 'write tests', status: 'in_progress', createdAt: 1, updatedAt: 1 },
      ],
      lastUpdated: 1,
    };
    const message = buildHandoverMessage({
      oldSessionId: 'session-old-1',
      todoList,
      recentMessages: [
        { role: 'user', text: 'please fix the bug' },
        { role: 'assistant', text: 'on it, created branch feature/fix-1' },
      ],
      workState: {
        branches: ['feature/fix-1'],
        pullRequests: ['https://github.com/o/r/pull/1'],
        repositories: ['https://github.com/o/r'],
        commits: ['abc1234'],
      },
    });

    expect(message).toContain('[System: Session Handover]');
    expect(message).toContain('session session-old-1 which became unresponsive');
    expect(message).toContain('## Previous Todo List');
    expect(message).toContain('- [completed] implement feature');
    expect(message).toContain('- [in_progress] write tests');
    expect(message).toContain('## Last Messages (most recent context)');
    expect(message).toContain('[user] please fix the bug');
    expect(message).toContain('## Detected Work State (best-effort)');
    expect(message).toContain('- Branch: feature/fix-1');
    expect(message).toContain('- Pull Request: https://github.com/o/r/pull/1');
    expect(message).toContain('unpushed local changes may have been lost');
    expect(message).toContain('## Instructions');
    expect(message).toContain('searchSessions (scope: "tree")');
  });

  test('omits todo and messages sections when empty', () => {
    const message = buildHandoverMessage({
      oldSessionId: 'session-old-2',
      todoList: null,
      recentMessages: [],
      workState: emptyWorkState,
    });
    expect(message).not.toContain('## Previous Todo List');
    expect(message).not.toContain('## Last Messages');
    expect(message).toContain('## Detected Work State (best-effort)');
    expect(message).toContain('## Instructions');
  });

  test('truncates long message bodies', () => {
    const message = buildHandoverMessage({
      oldSessionId: 'session-old-3',
      todoList: null,
      recentMessages: [{ role: 'assistant', text: 'x'.repeat(1000) }],
      workState: emptyWorkState,
      maxMessageChars: 100,
    });
    expect(message).toContain('… (truncated)');
    expect(message).not.toContain('x'.repeat(101));
  });
});
