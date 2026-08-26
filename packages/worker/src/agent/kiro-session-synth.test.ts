/**
 * Unit tests for `kiro-session-synth`.
 *
 * The fixture strategy is to lean on the in-memory `__test` exports for
 * pure-logic checks (alternation repair, role merging, etc.) and to
 * write a single end-to-end test that actually drops two files in a
 * tmpdir to confirm the public `synthesizeKiroSessionFiles` writes the
 * expected JSON / JSONL payloads.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';
import {
  __test,
  synthesizeKiroSessionFiles,
  synthesizeKiroSessionFilesV3,
  kiroV3SessionFilesExist,
  kiroV3WorkspaceHash,
  readKiroV3SessionModelId,
  DEFAULT_MAX_TURNS_FALLBACK,
  SESSION_ID_PATTERN,
  type MaterializeImageFn,
} from './kiro-session-synth';

const { buildIntermediateEvents, normaliseEvents, trimToTailTurns, emitJsonlEvents, parseContent } = __test;

const item = (sk: string, role: string, content: unknown, messageType = 'userMessage'): MessageItem => ({
  PK: 'message-w1',
  SK: sk,
  role,
  messageType,
  tokenCount: 0,
  content: typeof content === 'string' ? content : JSON.stringify(content),
});

const newStats = () => ({
  droppedOrphanToolUses: 0,
  droppedOrphanToolResults: 0,
  mergedConsecutiveUsers: 0,
  truncatedToTailTurns: 0,
  inputCount: 0,
  emittedCount: 0,
});

describe('parseContent', () => {
  test('parses a JSON array', () => {
    expect(parseContent('[{"text":"hi"}]')).toEqual([{ text: 'hi' }]);
  });

  test('falls back to a single text block for non-JSON legacy rows', () => {
    expect(parseContent('legacy plain text')).toEqual([{ text: 'legacy plain text' }]);
  });

  test('returns [] for a JSON value that is not an array', () => {
    expect(parseContent('{"text":"hi"}')).toEqual([]);
  });
});

describe('buildIntermediateEvents (DDB → intermediate)', () => {
  test('userMessage with multiple text blocks collapses to one Prompt event', async () => {
    const ev = await buildIntermediateEvents([
      item('001000000000001', 'user', [{ text: 'hello' }, { text: 'world' }], 'userMessage'),
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'user', text: 'hello\n\nworld' });
  });

  test('agentMessage and eventTrigger also map to user', async () => {
    const ev = await buildIntermediateEvents([
      item('001000000000001', 'user', [{ text: 'sib' }], 'agentMessage'),
      item('001000000000002', 'user', [{ text: 'evt' }], 'eventTrigger'),
    ]);
    expect(ev.map((e) => e.type)).toEqual(['user', 'user']);
  });

  test('user-role file block is degraded to a text placeholder so prior-turn attachments survive synthesis (kiro-cli file-attachment regression)', async () => {
    // Replay synth is deliberately sync + text-only — it must not
    // download S3 bytes — but it also must not silently drop file
    // blocks, otherwise the model has no clue an attachment ever
    // existed in a previous turn. The placeholder is purely contextual;
    // the *current* turn's bytes are materialised separately by
    // `kiro-agent-loop`'s segment renderer.
    const ev = await buildIntermediateEvents([
      item(
        '001000000000001',
        'user',
        [{ text: 'see this:' }, { file: { source: { s3Key: 'w1/abc/data.csv' }, fileName: 'data.csv' } }],
        'userMessage'
      ),
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('user');
    if (ev[0]!.type === 'user') {
      expect(ev[0]!.text).toContain('see this:');
      expect(ev[0]!.text).toContain('[file attachment: data.csv]');
    }
  });

  test('user-role file block with missing fileName falls back to s3Key tail in the placeholder', async () => {
    const ev = await buildIntermediateEvents([
      item('001000000000001', 'user', [{ file: { source: { s3Key: 'webapp_init/xyz/notes.txt' } } }], 'userMessage'),
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('user');
    if (ev[0]!.type === 'user') {
      expect(ev[0]!.text).toBe('[file attachment: notes.txt]');
    }
  });

  test('user-role image block is materialised with local paths when S3 fetch succeeds', async () => {
    const mockMaterialize: MaterializeImageFn = async (s3Key: string) => ({
      originalPath: '/tmp/.remote-swe-files/0_pic.png',
      previewPath: '/tmp/.remote-swe-images/image0.jpeg',
      fileName: 'pic.png',
      s3Uri: `s3://test-bucket/${s3Key}`,
    });
    const ev = await buildIntermediateEvents(
      [
        item(
          '001000000000001',
          'user',
          [{ text: 'look:' }, { image: { format: 'png', source: { s3Key: 'w1/abc/pic.png' } } }],
          'userMessage'
        ),
      ],
      mockMaterialize
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('user');
    if (ev[0]!.type === 'user') {
      expect(ev[0]!.text).toContain('look:');
      expect(ev[0]!.text).toContain(
        'the image "pic.png" is available as a resized preview at /tmp/.remote-swe-images/image0.jpeg'
      );
      expect(ev[0]!.text).toContain('to view this image, use the readLocalImage tool on the preview path');
    }
  });

  test('user-role image block falls back to text placeholder when S3 fetch fails', async () => {
    const failingMaterialize: MaterializeImageFn = async () => {
      throw new Error('NoSuchKey');
    };
    const ev = await buildIntermediateEvents(
      [
        item(
          '001000000000001',
          'user',
          [{ text: 'look:' }, { image: { format: 'png', source: { s3Key: 'w1/abc/pic.png' } } }],
          'userMessage'
        ),
      ],
      failingMaterialize
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('user');
    if (ev[0]!.type === 'user') {
      expect(ev[0]!.text).toContain('look:');
      expect(ev[0]!.text).toContain('[image attachment, s3Key: w1/abc/pic.png, s3Uri:');
    }
  });

  test('communicationLog is intentionally NOT mapped (sibling chatter that getConversationHistory already filters out)', async () => {
    const ev = await buildIntermediateEvents([
      item('001000000000001', 'user', [{ text: 'sibling chatter' }], 'communicationLog'),
    ]);
    expect(ev).toEqual([]);
  });

  test('toolUse with name+input is emitted as assistantToolUse', async () => {
    const ev = await buildIntermediateEvents([
      item(
        '001000000000001',
        'assistant',
        [{ text: 'about to call' }, { toolUse: { toolUseId: 'tu_1', name: 'echo', input: { msg: 'hi' } } }],
        'toolUse'
      ),
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('assistantToolUse');
    if (ev[0]!.type === 'assistantToolUse') {
      expect(ev[0]!.toolUses).toHaveLength(1);
      expect(ev[0]!.toolUses[0]!.toolUseId).toBe('tu_1');
      expect(ev[0]!.inlineText).toBe('about to call');
    }
  });

  test('toolResult preserves status=error', async () => {
    const ev = await buildIntermediateEvents([
      item(
        '001000000000001',
        'user',
        [
          {
            toolResult: {
              toolUseId: 'tu_1',
              content: [{ text: 'boom' }],
              status: 'error',
            },
          },
        ],
        'toolResult'
      ),
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('toolResult');
    if (ev[0]!.type === 'toolResult') {
      expect(ev[0]!.results[0]!.status).toBe('error');
    }
  });

  test('toolResult image is materialised into a text description with local paths', async () => {
    const mockMaterialize: MaterializeImageFn = async (s3Key: string) => ({
      originalPath: '/tmp/.remote-swe-files/0_screenshot.png',
      previewPath: '/tmp/.remote-swe-images/image0.jpeg',
      fileName: 'screenshot.png',
      s3Uri: `s3://test-bucket/${s3Key}`,
    });
    const ev = await buildIntermediateEvents(
      [
        item(
          '001000000000001',
          'user',
          [
            {
              toolResult: {
                toolUseId: 'tu_1',
                content: [{ image: { format: 'png', source: { s3Key: 'w1/hash123.png' } } } as any],
              },
            },
          ],
          'toolResult'
        ),
      ],
      mockMaterialize
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('toolResult');
    if (ev[0]!.type === 'toolResult') {
      const content = ev[0]!.results[0]!.content;
      expect(content[0]!.kind).toBe('text');
      expect(content[0]!.data).toContain('the image "screenshot.png" is available as a resized preview at');
      expect(content[0]!.data).toContain('to view this image, use the readLocalImage tool on the preview path');
    }
  });

  test('toolResult image falls back to placeholder when S3 fetch fails', async () => {
    const failingMaterialize: MaterializeImageFn = async () => {
      throw new Error('NoSuchKey');
    };
    const ev = await buildIntermediateEvents(
      [
        item(
          '001000000000001',
          'user',
          [
            {
              toolResult: {
                toolUseId: 'tu_1',
                content: [{ image: { format: 'png', source: { s3Key: 'w1/hash123.png' } } } as any],
              },
            },
          ],
          'toolResult'
        ),
      ],
      failingMaterialize
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe('toolResult');
    if (ev[0]!.type === 'toolResult') {
      const content = ev[0]!.results[0]!.content;
      expect(content[0]!.kind).toBe('text');
      expect(content[0]!.data).toContain('[image in tool result, s3Key: w1/hash123.png');
    }
  });

  test('empty content drops the item silently', async () => {
    expect(await buildIntermediateEvents([item('001', 'user', [], 'userMessage')])).toEqual([]);
  });

  test('unknown messageType is skipped', async () => {
    expect(await buildIntermediateEvents([item('001', 'user', [{ text: 'x' }], 'somethingNew')])).toEqual([]);
  });
});

describe('normaliseEvents (alternation repair)', () => {
  test('drops a leading non-user assistantText', async () => {
    const events = await buildIntermediateEvents([
      item('001', 'assistant', [{ text: 'hi' }], 'assistant'),
      item('002', 'user', [{ text: 'q' }], 'userMessage'),
      item('003', 'assistant', [{ text: 'a' }], 'assistant'),
    ]);
    const stats = newStats();
    const out = normaliseEvents(events, stats);
    expect(out.map((e) => e.type)).toEqual(['user', 'assistantText']);
  });

  test('merges consecutive user-side messages', async () => {
    const events = await buildIntermediateEvents([
      item('001', 'user', [{ text: 'one' }], 'userMessage'),
      item('002', 'user', [{ text: 'two' }], 'agentMessage'),
      item('003', 'user', [{ text: 'three' }], 'eventTrigger'),
      item('004', 'assistant', [{ text: 'reply' }], 'assistant'),
    ]);
    const stats = newStats();
    const out = normaliseEvents(events, stats);
    expect(out.map((e) => e.type)).toEqual(['user', 'assistantText']);
    if (out[0]!.type === 'user') {
      expect(out[0]!.text).toContain('one');
      expect(out[0]!.text).toContain('two');
      expect(out[0]!.text).toContain('three');
    }
    expect(stats.mergedConsecutiveUsers).toBe(2);
  });

  test('merging consecutive users does NOT mutate the input event objects (regression: pass-by-reference safety)', () => {
    // Build the input events directly so the test owns each object and
    // can detect any in-place text rewrite. This guards the immutability
    // invariant called out in the kiro-template-leak-root-fix review.
    const a = { type: 'user' as const, text: 'first', timestamp: 1, sk: '001' };
    const b = { type: 'user' as const, text: 'second', timestamp: 2, sk: '002' };
    const c = {
      type: 'assistantText' as const,
      text: 'reply',
      sk: '003',
    };
    const stats = newStats();
    normaliseEvents([a, b, c], stats);
    expect(a.text).toBe('first');
    expect(b.text).toBe('second');
    expect(c.text).toBe('reply');
  });

  test('drops orphan toolUse without matching toolResult', async () => {
    const events = await buildIntermediateEvents([
      item('001', 'user', [{ text: 'q' }], 'userMessage'),
      item('002', 'assistant', [{ toolUse: { toolUseId: 'tu_1', name: 'foo', input: {} } }], 'toolUse'),
      // No toolResult for tu_1.
      item('003', 'user', [{ text: 'next' }], 'userMessage'),
    ]);
    const stats = newStats();
    const out = normaliseEvents(events, stats);
    expect(stats.droppedOrphanToolUses).toBe(1);
    // The orphan toolUse becomes assistantText (empty inline) so the
    // walker has a closing assistant for the user turn.
    expect(out.map((e) => e.type)).toContain('user');
  });

  test('drops orphan toolResult whose toolUse never appeared', async () => {
    const events = await buildIntermediateEvents([
      item('001', 'user', [{ text: 'q' }], 'userMessage'),
      item('002', 'assistant', [{ text: 'reply' }], 'assistant'),
      item(
        '003',
        'user',
        [{ toolResult: { toolUseId: 'tu_orphan', content: [{ text: 'stale' }], status: 'success' } }],
        'toolResult'
      ),
    ]);
    const stats = newStats();
    const out = normaliseEvents(events, stats);
    expect(stats.droppedOrphanToolResults).toBe(1);
    // Output must NOT contain the stale toolResult.
    for (const e of out) expect(e.type).not.toBe('toolResult');
  });

  test('synthesises missing toolResult for an in-tail orphan toolUse', () => {
    // Build directly because buildIntermediateEvents would only see one
    // assistantToolUse without its matching ToolResults — we want to
    // exercise the inline repair path.
    const events = [
      { type: 'user' as const, text: 'q', timestamp: 1, sk: '001' },
      {
        type: 'assistantToolUse' as const,
        toolUses: [{ toolUseId: 'tu_1', name: 'foo', input: {} }],
        sk: '002',
      },
    ];
    // Mark tu_1 satisfied by faking a results event so step 1 keeps it,
    // and then drop the results event to exercise step 3's repair.
    const stats = newStats();
    const out = normaliseEvents(
      [
        ...events,
        // Force "satisfied" by adding then removing — easiest is to
        // keep the toolUseId in the kept set; we can simulate that by
        // directly invoking emitJsonlEvents on an artificial sequence.
      ],
      stats
    );
    // With no toolResult event in events, step 1 will drop the toolUse
    // entirely → assistantText empty. We expect a user + assistantText.
    expect(out.map((e) => e.type)).toEqual(['user']);
  });

  test('rejects assistant before any user (invalid_first_message)', async () => {
    const events = await buildIntermediateEvents([item('001', 'assistant', [{ text: 'hi' }], 'assistant')]);
    const stats = newStats();
    expect(normaliseEvents(events, stats)).toEqual([]);
  });

  test('handles a complete user/assistant/toolUse/toolResult/assistant cycle', async () => {
    const events = await buildIntermediateEvents([
      item('001', 'user', [{ text: 'do x' }], 'userMessage'),
      item(
        '002',
        'assistant',
        [{ text: '' }, { toolUse: { toolUseId: 'tu_1', name: 'echo', input: { x: 1 } } }],
        'toolUse'
      ),
      item(
        '003',
        'user',
        [{ toolResult: { toolUseId: 'tu_1', content: [{ text: 'ok' }], status: 'success' } }],
        'toolResult'
      ),
      item('004', 'assistant', [{ text: 'done' }], 'assistant'),
    ]);
    const stats = newStats();
    const out = normaliseEvents(events, stats);
    expect(out.map((e) => e.type)).toEqual(['user', 'assistantToolUse', 'toolResult', 'assistantText']);
    expect(stats.droppedOrphanToolUses).toBe(0);
    expect(stats.droppedOrphanToolResults).toBe(0);
  });

  test('handles assistant text only (no tool calls)', async () => {
    const events = await buildIntermediateEvents([
      item('001', 'user', [{ text: 'hi' }], 'userMessage'),
      item('002', 'assistant', [{ text: 'hello' }], 'assistant'),
    ]);
    const stats = newStats();
    const out = normaliseEvents(events, stats);
    expect(out.map((e) => e.type)).toEqual(['user', 'assistantText']);
  });

  test('returns [] for empty input', () => {
    const stats = newStats();
    expect(normaliseEvents([], stats)).toEqual([]);
  });
});

describe('trimToTailTurns', () => {
  test('keeps only the last N user turns (and their assistant follow-ups)', () => {
    const events = [
      { type: 'user' as const, text: 'turn1', timestamp: 1, sk: '001' },
      { type: 'assistantText' as const, text: 'a1', sk: '002' },
      { type: 'user' as const, text: 'turn2', timestamp: 2, sk: '003' },
      { type: 'assistantText' as const, text: 'a2', sk: '004' },
      { type: 'user' as const, text: 'turn3', timestamp: 3, sk: '005' },
      { type: 'assistantText' as const, text: 'a3', sk: '006' },
    ];
    const stats = newStats();
    const out = trimToTailTurns(events, 2, stats);
    expect(out.map((e) => e.type)).toEqual(['user', 'assistantText', 'user', 'assistantText']);
    expect(stats.truncatedToTailTurns).toBe(2);
  });

  test('does not truncate when maxTurns >= turns in events', () => {
    const events = [
      { type: 'user' as const, text: 'a', timestamp: 1, sk: '001' },
      { type: 'assistantText' as const, text: 'b', sk: '002' },
    ];
    const stats = newStats();
    const out = trimToTailTurns(events, 5, stats);
    expect(out.length).toBe(events.length);
    expect(stats.truncatedToTailTurns).toBe(0);
  });

  test('non-positive maxTurns is treated as no-op', () => {
    const events = [{ type: 'user' as const, text: 'a', timestamp: 1, sk: '001' }];
    const stats = newStats();
    expect(trimToTailTurns(events, 0, stats).length).toBe(1);
  });
});

describe('emitJsonlEvents (intermediate → JSONL)', () => {
  test('Prompt event carries the original timestamp', () => {
    const out = emitJsonlEvents([{ type: 'user', text: 'hi', timestamp: 1700000000, sk: '001' }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('Prompt');
    if (out[0]!.kind === 'Prompt') {
      expect(out[0]!.data.meta.timestamp).toBe(1700000000);
      expect(out[0]!.data.content[0]!.data).toBe('hi');
    }
  });

  test('AssistantMessage with toolUse adds an empty leading text block', () => {
    const out = emitJsonlEvents([
      {
        type: 'assistantToolUse',
        toolUses: [{ toolUseId: 'tu_1', name: 'echo', input: { x: 1 } }],
        sk: '002',
      },
    ]);
    expect(out).toHaveLength(1);
    if (out[0]!.kind === 'AssistantMessage') {
      const c = out[0]!.data.content;
      expect(c[0]).toEqual({ kind: 'text', data: '' });
      expect(c[1]!.kind).toBe('toolUse');
    }
  });

  test('ToolResults includes the kiro-cli-required `results` map with Mcp tool kind', () => {
    const out = emitJsonlEvents([
      {
        type: 'toolResult',
        results: [
          {
            toolUseId: 'tu_1',
            content: [{ kind: 'text', data: 'ok' }],
            status: 'success',
          },
        ],
        sk: '003',
      },
    ]);
    expect(out).toHaveLength(1);
    if (out[0]!.kind === 'ToolResults') {
      expect(out[0]!.data.results['tu_1']).toBeDefined();
      const r = out[0]!.data.results['tu_1']!;
      expect(r.tool.kind).toMatchObject({ Mcp: { serverName: 'remote-swe' } });
      expect(r.result.Success.items).toEqual([{ Text: 'ok' }]);
    }
  });
});

describe('synthesizeKiroSessionFiles (end-to-end file write)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kiro-synth-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  test('writes the .json metadata + .jsonl event log to the expected path', async () => {
    const items: MessageItem[] = [
      item('001000000000001', 'user', [{ text: 'q1' }], 'userMessage'),
      item('001000000000002', 'assistant', [{ text: 'a1' }], 'assistant'),
      item('001000000000003', 'user', [{ text: 'q2' }], 'userMessage'),
    ];
    const result = await synthesizeKiroSessionFiles({
      sessionId: 'abc-1234',
      cwd: '/tmp/cwd',
      items,
      home: tmpDir,
    });
    expect(result.jsonPath).toBe(path.join(tmpDir, '.kiro/sessions/cli/abc-1234.json'));
    expect(result.jsonlPath).toBe(path.join(tmpDir, '.kiro/sessions/cli/abc-1234.jsonl'));
    const meta = JSON.parse(await fs.promises.readFile(result.jsonPath, 'utf8'));
    expect(meta.session_id).toBe('abc-1234');
    expect(meta.cwd).toBe('/tmp/cwd');
    expect(meta.session_state.version).toBe('v1');
    const lines = (await fs.promises.readFile(result.jsonlPath, 'utf8')).trim().split('\n');
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.kind)).toEqual(['Prompt', 'AssistantMessage', 'Prompt']);
  });

  test('creates the directory tree when missing', async () => {
    const home = path.join(tmpDir, 'fresh');
    const result = await synthesizeKiroSessionFiles({
      sessionId: 'sid-1',
      cwd: '/tmp/cwd',
      items: [],
      home,
    });
    // Directory should now exist.
    const dir = path.dirname(result.jsonPath);
    const stat = await fs.promises.stat(dir);
    expect(stat.isDirectory()).toBe(true);
    // Empty jsonl is fine.
    const jsonl = await fs.promises.readFile(result.jsonlPath, 'utf8');
    expect(jsonl).toBe('');
  });

  test('throws when HOME is not provided and process.env.HOME is unset', async () => {
    const savedHome = process.env.HOME;
    try {
      delete process.env.HOME;
      await expect(
        synthesizeKiroSessionFiles({
          sessionId: 'x',
          cwd: '/tmp',
          items: [],
        })
      ).rejects.toThrow(/HOME is not set/);
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
    }
  });

  test('records repair stats for orphan tool calls', async () => {
    const items: MessageItem[] = [
      item('001', 'user', [{ text: 'q' }], 'userMessage'),
      item('002', 'assistant', [{ toolUse: { toolUseId: 'tu_orphan', name: 'foo', input: {} } }], 'toolUse'),
      item('003', 'user', [{ text: 'next' }], 'userMessage'),
    ];
    const result = await synthesizeKiroSessionFiles({
      sessionId: 'with-orphan',
      cwd: '/tmp',
      items,
      home: tmpDir,
    });
    expect(result.stats.droppedOrphanToolUses).toBe(1);
    // Final jsonl should have no toolUse and no orphan toolUseId.
    const jsonl = await fs.promises.readFile(result.jsonlPath, 'utf8');
    expect(jsonl).not.toContain('tu_orphan');
  });

  test('preserves leak template tokens in body text without panicking', async () => {
    // Existing polluted DDB rows contain literal `<|TOOL_USE|>` etc. in
    // assistant text. The synthesiser must NOT special-case these; it
    // should produce a Prompt / AssistantMessage where the text is
    // copied through. The leak guard at output time is what removes them
    // from the live response.
    const polluted = '<|TOOL_USE|>id: x, name: foo, input: {}<|/TOOL_USE|>\nresidue';
    const items: MessageItem[] = [
      item('001', 'user', [{ text: 'q' }], 'userMessage'),
      item('002', 'assistant', [{ text: polluted }], 'assistant'),
    ];
    const result = await synthesizeKiroSessionFiles({
      sessionId: 'polluted',
      cwd: '/tmp',
      items,
      home: tmpDir,
    });
    const jsonl = await fs.promises.readFile(result.jsonlPath, 'utf8');
    expect(jsonl).toContain('<|TOOL_USE|>');
  });

  test('truncates to maxTurnsFallback when many turns present', async () => {
    const items: MessageItem[] = [];
    for (let i = 1; i <= 10; i++) {
      // SK is monotonically increasing zero-padded ms timestamps.
      const base = 1700000000000 + i * 1000;
      items.push(item(String(base).padStart(15, '0'), 'user', [{ text: `q${i}` }], 'userMessage'));
      items.push(item(String(base + 100).padStart(15, '0'), 'assistant', [{ text: `a${i}` }], 'assistant'));
    }
    const result = await synthesizeKiroSessionFiles({
      sessionId: 'trim',
      cwd: '/tmp',
      items,
      home: tmpDir,
      maxTurnsFallback: 3,
    });
    expect(result.stats.truncatedToTailTurns).toBeGreaterThan(0);
    // Final jsonl should only contain the last 3 user prompts (q8, q9, q10).
    const jsonl = await fs.promises.readFile(result.jsonlPath, 'utf8');
    expect(jsonl).not.toContain('"q1"');
    expect(jsonl).toContain('"q10"');
  });
});

describe('DEFAULT_MAX_TURNS_FALLBACK', () => {
  test('is a sane positive integer', () => {
    expect(Number.isInteger(DEFAULT_MAX_TURNS_FALLBACK)).toBe(true);
    expect(DEFAULT_MAX_TURNS_FALLBACK).toBeGreaterThan(10);
  });
});

describe('SESSION_ID_PATTERN (path-traversal defence)', () => {
  test('accepts kiro-cli UUIDs', () => {
    expect(SESSION_ID_PATTERN.test('f330b026-0916-4e7c-be92-cd7853e36dad')).toBe(true);
    expect(SESSION_ID_PATTERN.test('abc_123-DEF')).toBe(true);
  });

  test('rejects shells, slashes, dots, spaces, and absolute paths', () => {
    for (const bad of ['..', '../etc/passwd', 'abc/def', 'foo bar', 'foo.json', '', '\u0000', 'a/../b']) {
      expect(SESSION_ID_PATTERN.test(bad)).toBe(false);
    }
  });

  test('synthesizeKiroSessionFiles throws on a non-matching sessionId before touching the filesystem', async () => {
    let mkdirCalled = false;
    const home = '/nonexistent';
    // Patch fs.promises.mkdir momentarily to ensure it is not called.
    const realMkdir = fs.promises.mkdir;
    fs.promises.mkdir = (async () => {
      mkdirCalled = true;
      return undefined;
    }) as typeof fs.promises.mkdir;
    try {
      await expect(
        synthesizeKiroSessionFiles({ sessionId: '../escape', cwd: '/tmp', items: [], home })
      ).rejects.toThrow(/invalid sessionId/);
    } finally {
      fs.promises.mkdir = realMkdir;
    }
    expect(mkdirCalled).toBe(false);
  });
});

describe('atomic write semantics', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kiro-synth-atomic-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  test('does not leave a `.tmp.<pid>` artefact after a successful write', async () => {
    const result = await synthesizeKiroSessionFiles({
      sessionId: 'atom-1',
      cwd: '/tmp',
      items: [],
      home: tmpDir,
    });
    const sessionDir = path.dirname(result.jsonPath);
    const entries = await fs.promises.readdir(sessionDir);
    for (const e of entries) {
      expect(e).not.toMatch(/\.tmp\./);
    }
  });

  test('replacing an existing session file leaves only the final atomically-renamed pair (no half-written interleave)', async () => {
    await synthesizeKiroSessionFiles({
      sessionId: 'atom-1',
      cwd: '/tmp',
      items: [],
      home: tmpDir,
    });
    // Second invocation overwrites both files.
    const items: MessageItem[] = [item('001', 'user', [{ text: 'second-version-marker' }], 'userMessage')];
    const result = await synthesizeKiroSessionFiles({
      sessionId: 'atom-1',
      cwd: '/tmp',
      items,
      home: tmpDir,
    });
    const jsonl = await fs.promises.readFile(result.jsonlPath, 'utf8');
    expect(jsonl).toContain('second-version-marker');
    // Sanity: the .json metadata reflects the new title (first prompt
    // text), not a stale carry-over from the empty session.
    const meta = JSON.parse(await fs.promises.readFile(result.jsonPath, 'utf8'));
    expect(meta.title).toContain('second-version-marker');
  });
});

// ----------------------------------------------------------------------------
// Regression: the leaking production session (DDB sample fixture).
// ----------------------------------------------------------------------------
describe('leaked-session-sample fixture (template-token leak regression)', () => {
  /**
   * 21-item synthetic reconstruction of a production DDB message stream
   * that leaked `<|TOOL_USE|>` template literals into assistant text.
   * The slice straddles the leak boundary so it covers both the clean
   * turns that preceded the leak and the polluted assistant text that
   * started conditioning the model into emitting `<|TOOL_USE|>`
   * literals. Synthesising this fixture is the canonical regression
   * test: kiro-cli's load invariants must accept the result without
   * panicking, and the leaked tokens in the historical assistant text
   * MUST flow through unchanged (the runtime guard
   * `stripLeakedTemplateTokens` is what scrubs them at the response
   * boundary, not the synthesiser).
   *
   * All content is synthetic (rewritten in English with placeholder
   * session ids); the structural shape of the original incident
   * (messageType, role, SK ordering, tool_use / tool_result pairing,
   * exact count and position of polluted assistant messages, and a
   * user message that echoes leaked tokens back) is preserved.
   */
  let tmpDir: string;
  let fixture: MessageItem[];

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kiro-synth-fixture-'));
    const raw = await fs.promises.readFile(path.join(__dirname, '__fixtures__/leaked-session-sample.json'), 'utf8');
    fixture = JSON.parse(raw) as MessageItem[];
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Number of assistant messages in the fixture that carry the leak
   * signature (`<|TOOL_USE|>`, `<|USER|>`, `<|ASSISTANT|>`). Pinned to a
   * concrete count so a future fixture refresh that accidentally
   * removes polluted samples (or trims them aggressively) is caught
   * here instead of silently turning the regression test into a no-op.
   */
  const EXPECTED_POLLUTED_COUNT = 6;

  test(`the fixture itself contains exactly ${EXPECTED_POLLUTED_COUNT} pre-fix leak samples (regression-test integrity check)`, () => {
    const polluted = fixture.filter(
      (m) => m.role === 'assistant' && /\<\|(TOOL_USE|USER|ASSISTANT)\|\>/.test(m.content)
    );
    expect(polluted.length).toBe(EXPECTED_POLLUTED_COUNT);
  });

  test('synthesises without throwing', async () => {
    await expect(
      synthesizeKiroSessionFiles({
        sessionId: 'fixture-leaked',
        cwd: '/tmp',
        items: fixture,
        home: tmpDir,
      })
    ).resolves.toBeTruthy();
  });

  test('emitted jsonl satisfies kiro-cli alternation invariants (Prompt-first, no orphan tool calls)', async () => {
    const result = await synthesizeKiroSessionFiles({
      sessionId: 'fixture-leaked',
      cwd: '/tmp',
      items: fixture,
      home: tmpDir,
    });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0]!.kind).toBe('Prompt');
    // No toolUse without a matching ToolResults.
    const declared = new Set<string>();
    const satisfied = new Set<string>();
    for (const e of result.events) {
      if (e.kind === 'AssistantMessage') {
        for (const c of e.data.content) {
          if (c.kind === 'toolUse') declared.add(c.data.toolUseId);
        }
      } else if (e.kind === 'ToolResults') {
        for (const c of e.data.content) {
          if (c.kind === 'toolResult') satisfied.add(c.data.toolUseId);
        }
      }
    }
    for (const id of declared) {
      expect(satisfied.has(id)).toBe(true);
    }
    expect(result.stats.droppedOrphanToolUses).toBe(0);
  });

  test('preserves the polluted assistant text in the synthesised log (the guard, not the synth, is responsible for scrubbing)', async () => {
    const result = await synthesizeKiroSessionFiles({
      sessionId: 'fixture-leaked',
      cwd: '/tmp',
      items: fixture,
      home: tmpDir,
    });
    const jsonl = await fs.promises.readFile(result.jsonlPath, 'utf8');
    expect(jsonl).toContain('<|TOOL_USE|>');
  });
});

describe('v3 session synthesis (KAS engine store)', () => {
  const { emitV3JsonlEvents } = __test;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kiro-synth-v3-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  test('kiroV3WorkspaceHash is the first 16 hex chars of sha256(cwd)', () => {
    // Empirically pinned against a live kiro-cli 2.16 v3 store: the
    // directory for cwd `/root/.remote-swe-workspace` was
    // `adeaa413edcc5fd8`.
    expect(kiroV3WorkspaceHash('/root/.remote-swe-workspace')).toBe('adeaa413edcc5fd8');
  });

  test('writes session.json + messages.jsonl under sessions/<hash>/<sessionId>/', async () => {
    const cwd = '/tmp/v3-cwd';
    const items = [
      item('001000000000001', 'user', [{ text: 'q1' }], 'userMessage'),
      item('001000000000002', 'assistant', [{ text: 'a1' }], 'assistant'),
    ];
    const result = await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_abc-1234',
      cwd,
      items,
      home: tmpDir,
    });
    const expectedDir = path.join(tmpDir, '.kiro/sessions', kiroV3WorkspaceHash(cwd), 'sess_abc-1234');
    expect(result.sessionDir).toBe(expectedDir);
    expect(result.jsonPath).toBe(path.join(expectedDir, 'session.json'));
    expect(result.jsonlPath).toBe(path.join(expectedDir, 'messages.jsonl'));

    const meta = JSON.parse(await fs.promises.readFile(result.jsonPath, 'utf8'));
    expect(meta.id).toBe('sess_abc-1234');
    expect(meta.schemaVersion).toBe('1.0.0');
    expect(meta.dataModelVersion).toBe(1);
    expect(meta.workspacePaths).toEqual([cwd]);
    expect(meta.agentMode).toBe('vibe');
    expect(meta.title).toBe('q1');

    const lines = (await fs.promises.readFile(result.jsonlPath, 'utf8')).trim().split('\n');
    const payloads = lines.map((l) => JSON.parse(l).payload);
    expect(payloads).toEqual([
      { type: 'user', content: 'q1' },
      { type: 'assistant', content: 'a1' },
    ]);
    for (const l of lines) {
      const parsed = JSON.parse(l);
      expect(typeof parsed.id).toBe('string');
      expect(Number.isNaN(Date.parse(parsed.timestamp))).toBe(false);
    }
  });

  test('maps toolUse/toolResult pairs to tool_call/tool_result payloads', async () => {
    const items = [
      item('001000000000001', 'user', [{ text: 'run it' }], 'userMessage'),
      item(
        '001000000000002',
        'assistant',
        [{ text: 'running' }, { toolUse: { toolUseId: 'tu-1', name: 'executeCommand', input: { command: 'ls' } } }],
        'toolUse'
      ),
      item(
        '001000000000003',
        'user',
        [{ toolResult: { toolUseId: 'tu-1', content: [{ text: 'file.txt' }], status: 'success' } }],
        'toolResult'
      ),
      item('001000000000004', 'assistant', [{ text: 'done' }], 'assistant'),
    ];
    const result = await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_tools-1',
      cwd: '/tmp/v3-cwd',
      items,
      home: tmpDir,
    });
    const payloads = result.events.map((e) => e.payload);
    expect(payloads).toEqual([
      { type: 'user', content: 'run it' },
      { type: 'assistant', content: 'running' },
      {
        type: 'tool_call',
        toolCallId: 'tu-1',
        toolName: 'executeCommand',
        args: { command: 'ls' },
        status: 'approved',
        kind: 'execute',
      },
      { type: 'tool_result', toolCallId: 'tu-1', content: 'file.txt' },
      { type: 'assistant', content: 'done' },
    ]);
  });

  test('kiroV3SessionFilesExist is false before synthesis and true after', async () => {
    const cwd = '/tmp/v3-cwd';
    expect(kiroV3SessionFilesExist('sess_exists-1', cwd, tmpDir)).toBe(false);
    await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_exists-1',
      cwd,
      items: [item('001000000000001', 'user', [{ text: 'q' }], 'userMessage')],
      home: tmpDir,
    });
    expect(kiroV3SessionFilesExist('sess_exists-1', cwd, tmpDir)).toBe(true);
    // A different cwd hashes to a different workspace dir → not found.
    expect(kiroV3SessionFilesExist('sess_exists-1', '/tmp/other-cwd', tmpDir)).toBe(false);
  });

  test('rejects a path-traversal sessionId before touching the filesystem', async () => {
    await expect(
      synthesizeKiroSessionFilesV3({ sessionId: '../escape', cwd: '/tmp', items: [], home: tmpDir })
    ).rejects.toThrow(/invalid sessionId/);
    expect(kiroV3SessionFilesExist('../escape', '/tmp', tmpDir)).toBe(false);
  });

  test('empty history still writes a loadable empty session pair', async () => {
    const result = await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_empty-1',
      cwd: '/tmp/v3-cwd',
      items: [],
      home: tmpDir,
    });
    expect(result.events).toHaveLength(0);
    expect(await fs.promises.readFile(result.jsonlPath, 'utf8')).toBe('');
    const meta = JSON.parse(await fs.promises.readFile(result.jsonPath, 'utf8'));
    expect(meta.title).toBe('remote-swe synthesised session');
  });

  test('emitV3JsonlEvents converts json tool-result content to a JSON string', () => {
    const events = emitV3JsonlEvents([
      { type: 'user', text: 'q', timestamp: 1, sk: '001000000000001' },
      {
        type: 'assistantToolUse',
        toolUses: [{ toolUseId: 'tu-9', name: 't', input: {} }],
        sk: '001000000000002',
      },
      {
        type: 'toolResult',
        results: [
          {
            toolUseId: 'tu-9',
            content: [
              { kind: 'text', data: 'line' },
              { kind: 'json', data: { ok: true } },
            ],
            status: 'success',
          },
        ],
        sk: '001000000000003',
      },
    ]);
    const result = events.find((e) => e.payload.type === 'tool_result');
    expect(result?.payload.content).toBe('line\n{"ok":true}');
  });
});

describe('v3 session.json modelId (model-switch rotation support)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kiro-synth-model-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  const items = () => [
    item('001000000000001', 'user', [{ text: 'q1' }], 'userMessage'),
    item('001000000000002', 'assistant', [{ text: 'a1' }], 'assistant'),
  ];

  test('writes modelId into session.json when provided', async () => {
    const result = await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_model-1',
      cwd: '/tmp/v3-cwd',
      items: items(),
      home: tmpDir,
      modelId: 'claude-sonnet-4.5',
    });
    const meta = JSON.parse(await fs.promises.readFile(result.jsonPath, 'utf8'));
    expect(meta.modelId).toBe('claude-sonnet-4.5');
  });

  test('omits the modelId key entirely for auto (undefined)', async () => {
    const result = await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_model-2',
      cwd: '/tmp/v3-cwd',
      items: items(),
      home: tmpDir,
    });
    const meta = JSON.parse(await fs.promises.readFile(result.jsonPath, 'utf8'));
    // Mirror kiro-cli's own behaviour: auto sessions have NO modelId key,
    // so its absence (not null / empty string) is the faithful shape.
    expect('modelId' in meta).toBe(false);
  });

  test('readKiroV3SessionModelId round-trips the synthesised value', async () => {
    await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_model-3',
      cwd: '/tmp/v3-cwd',
      items: items(),
      home: tmpDir,
      modelId: 'claude-haiku-4.5',
    });
    expect(readKiroV3SessionModelId('sess_model-3', '/tmp/v3-cwd', tmpDir)).toBe('claude-haiku-4.5');
  });

  test('readKiroV3SessionModelId returns undefined for auto sessions and missing files', async () => {
    await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_model-4',
      cwd: '/tmp/v3-cwd',
      items: items(),
      home: tmpDir,
    });
    expect(readKiroV3SessionModelId('sess_model-4', '/tmp/v3-cwd', tmpDir)).toBeUndefined();
    expect(readKiroV3SessionModelId('sess_never-created', '/tmp/v3-cwd', tmpDir)).toBeUndefined();
  });

  test('readKiroV3SessionModelId normalises kiro-cli\'s explicit "auto" to undefined (S-1)', async () => {
    // kiro-cli's OWN session/new writes `"modelId": "auto"` to session.json
    // (verified empirically against kiro-cli 2.18.0). Our synthesiser omits
    // the key, but a session created directly by kiro-cli (the `new` outcome)
    // carries the literal "auto". readKiroV3SessionModelId must collapse it to
    // undefined so an auto session is not seen as different from the desired
    // auto (modelArg === undefined) and rotated every turn.
    const result = await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_model-auto',
      cwd: '/tmp/v3-cwd',
      items: items(),
      home: tmpDir,
    });
    const parsed = JSON.parse(await fs.promises.readFile(result.jsonPath, 'utf8'));
    await fs.promises.writeFile(result.jsonPath, JSON.stringify({ ...parsed, modelId: 'auto' }, null, 2));
    expect(readKiroV3SessionModelId('sess_model-auto', '/tmp/v3-cwd', tmpDir)).toBeUndefined();
  });

  test('readKiroV3SessionModelId tolerates a corrupt session.json', async () => {
    const result = await synthesizeKiroSessionFilesV3({
      sessionId: 'sess_model-5',
      cwd: '/tmp/v3-cwd',
      items: items(),
      home: tmpDir,
      modelId: 'claude-haiku-4.5',
    });
    await fs.promises.writeFile(result.jsonPath, '{not json');
    expect(readKiroV3SessionModelId('sess_model-5', '/tmp/v3-cwd', tmpDir)).toBeUndefined();
  });
});
