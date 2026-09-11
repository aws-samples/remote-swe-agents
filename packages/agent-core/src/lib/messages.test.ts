import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { MessageItem } from '../schema';

const mockSend = vi.fn();
const mockPaginateQuery = vi.fn();
const mockGetBytesFromKey = vi.fn();

vi.mock('./aws/ddb', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
}));

vi.mock('./aws/s3', () => ({
  writeBytesToKey: vi.fn(),
  getBytesFromKey: (...args: any[]) => mockGetBytesFromKey(...args),
  BucketName: 'test-bucket',
}));

vi.mock('./events', () => ({
  sendWebappEvent: vi.fn(),
}));

vi.mock('./slack', () => ({
  sendMessageToSlack: vi.fn(),
}));

vi.mock('./webapp-origin', () => ({
  getWebappSessionUrl: vi.fn(),
}));

const mockUpdateSessionLastMessage = vi.fn();
vi.mock('./sessions', () => ({
  updateSessionLastMessage: (...args: any[]) => mockUpdateSessionLastMessage(...args),
}));

vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    paginateQuery: (...args: any[]) => mockPaginateQuery(...args),
  };
});

import {
  getConversationHistory,
  getLatestMessageSK,
  getRecentMessages,
  messageSKFromTimestamp,
  parseContentBlocks,
  saveConversationHistory,
  imageFormatFromExtension,
  middleOutFiltering,
  noOpFiltering,
  ensureImageWithinBounds,
  materializeImageBlock,
  sendSystemMessage,
} from './messages';

// ----------------------------------------------------------------------------
// imageFormatFromExtension: S3-key-extension → Bedrock-format normalisation.
//
// Regression guard for the ".jpg on the current turn" bug: before the fix,
// `postProcessMessageContent` used `s3Key.split('.').pop()!` verbatim, which
// passed `"jpg"` straight through to Bedrock Converse's `image.format` field.
// Bedrock's enum is `'png' | 'jpeg' | 'gif' | 'webp'` — `"jpg"` was rejected
// at ValidationException time, tanking the whole turn.
// ----------------------------------------------------------------------------
describe('imageFormatFromExtension', () => {
  test('passes through png / jpeg / gif / webp unchanged', () => {
    expect(imageFormatFromExtension('png')).toBe('png');
    expect(imageFormatFromExtension('jpeg')).toBe('jpeg');
    expect(imageFormatFromExtension('gif')).toBe('gif');
    expect(imageFormatFromExtension('webp')).toBe('webp');
  });

  test('normalises jpg to jpeg (Bedrock does not accept "jpg")', () => {
    expect(imageFormatFromExtension('jpg')).toBe('jpeg');
  });

  test('is case-insensitive', () => {
    expect(imageFormatFromExtension('JPG')).toBe('jpeg');
    expect(imageFormatFromExtension('JPEG')).toBe('jpeg');
    expect(imageFormatFromExtension('PNG')).toBe('png');
    expect(imageFormatFromExtension('WebP')).toBe('webp');
  });

  test('falls back to webp for non-standard / unknown extensions', () => {
    expect(imageFormatFromExtension('tiff')).toBe('webp');
    expect(imageFormatFromExtension('bmp')).toBe('webp');
    expect(imageFormatFromExtension('svg')).toBe('webp');
    expect(imageFormatFromExtension('')).toBe('webp');
    expect(imageFormatFromExtension('bin')).toBe('webp');
  });
});

const makeItem = (sk: string, messageType: string, extra: Partial<MessageItem> = {}): MessageItem => ({
  PK: 'message-worker-1',
  SK: sk,
  content: '[]',
  role: 'user',
  tokenCount: 0,
  messageType,
  ...extra,
});

const mockPages = (items: MessageItem[]) => {
  mockPaginateQuery.mockImplementation(() => {
    return {
      async *[Symbol.asyncIterator]() {
        yield { Items: items };
      },
    };
  });
};

describe('getConversationHistory', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockPaginateQuery.mockReset();
  });

  test('excludes communicationLog items by default (LLM-safe default)', async () => {
    const items = [
      makeItem('001', 'userMessage'),
      makeItem('002', 'communicationLog', { senderSessionId: 'sibling-a', targetSessionId: 'sibling-b' }),
      makeItem('003', 'assistant'),
      makeItem('004', 'communicationLog', { senderSessionId: 'sibling-b', targetSessionId: 'sibling-a' }),
      makeItem('005', 'userMessage'),
    ];
    mockPages(items);

    const { items: result } = await getConversationHistory('worker-1');

    expect(result.map((i) => i.SK)).toEqual(['001', '003', '005']);
    expect(result.every((i) => i.messageType !== 'communicationLog')).toBe(true);
  });

  test('includes communicationLog items when includeAll: true (UI use case)', async () => {
    const items = [
      makeItem('001', 'userMessage'),
      makeItem('002', 'communicationLog'),
      makeItem('003', 'assistant'),
      makeItem('004', 'agentMessage'),
    ];
    mockPages(items);

    const { items: result } = await getConversationHistory('worker-1', { includeAll: true });

    expect(result.map((i) => i.SK)).toEqual(['001', '002', '003', '004']);
  });

  test('keeps agentMessage items in the default (filtered) view', async () => {
    const items = [
      makeItem('001', 'userMessage'),
      makeItem('002', 'agentMessage', { senderSessionId: 'parent', targetSessionId: 'worker-1' }),
      makeItem('003', 'communicationLog'),
    ];
    mockPages(items);

    const { items: result } = await getConversationHistory('worker-1');

    // agentMessage must survive — it is the actual incoming message to this agent.
    expect(result.map((i) => i.messageType)).toEqual(['userMessage', 'agentMessage']);
  });

  test('returns empty array when no items', async () => {
    mockPages([]);

    const { items: result, slackUserId } = await getConversationHistory('worker-1');

    expect(result).toEqual([]);
    expect(slackUserId).toBeUndefined();
  });

  test('slackUserId lookup only considers items that survive filtering', async () => {
    // Deliberately order so that a communicationLog with a slackUserId appears AFTER the
    // latest userMessage. Without the filter, the lookup scans from the tail and would
    // return `U_COMM` from the communicationLog row. With the default filter it must
    // return `U_NEW` from the last surviving userMessage instead.
    const items = [
      makeItem('001', 'userMessage', { slackUserId: 'U_OLD' }),
      makeItem('002', 'userMessage', { slackUserId: 'U_NEW' }),
      makeItem('003', 'communicationLog', { slackUserId: 'U_COMM' }),
    ];
    mockPages(items);

    const { slackUserId } = await getConversationHistory('worker-1');

    expect(slackUserId).toBe('U_NEW');
  });

  test('slackUserId lookup with includeAll: true scans the full history (sanity check for the filtered version above)', async () => {
    // Same fixture as the filtered test, but with includeAll: true the last row wins.
    // This confirms the previous test genuinely exercises the filter path.
    const items = [
      makeItem('001', 'userMessage', { slackUserId: 'U_OLD' }),
      makeItem('002', 'userMessage', { slackUserId: 'U_NEW' }),
      makeItem('003', 'communicationLog', { slackUserId: 'U_COMM' }),
    ];
    mockPages(items);

    const { slackUserId } = await getConversationHistory('worker-1', { includeAll: true });

    expect(slackUserId).toBe('U_COMM');
  });
});

describe('middleOutFiltering (LLM-safety guard)', () => {
  test('unconditionally drops communicationLog items even when they are passed through includeAll', async () => {
    // Simulate a future caller that accidentally passed `includeAll: true` to a history
    // fetch whose result then flows into an LLM. middleOutFiltering must defend the LLM
    // context regardless of what the caller did upstream.
    const items: MessageItem[] = [
      makeItem('001', 'userMessage', { tokenCount: 100 }),
      makeItem('002', 'communicationLog', { tokenCount: 0 }),
      makeItem('003', 'assistant', { tokenCount: 50 }),
      makeItem('004', 'communicationLog', { tokenCount: 0 }),
      makeItem('005', 'userMessage', { tokenCount: 30 }),
    ];

    const { items: filtered, totalTokenCount } = await middleOutFiltering(items);

    expect(filtered.map((i) => i.messageType)).toEqual(['userMessage', 'assistant', 'userMessage']);
    expect(filtered.every((i) => i.messageType !== 'communicationLog')).toBe(true);
    // Only the surviving rows contribute to the token total.
    expect(totalTokenCount).toBe(180);
  });

  test('does not change behaviour for histories without communicationLog', async () => {
    const items: MessageItem[] = [
      makeItem('001', 'userMessage', { tokenCount: 10 }),
      makeItem('002', 'assistant', { tokenCount: 20 }),
      makeItem('003', 'userMessage', { tokenCount: 30 }),
    ];

    const { items: filtered, totalTokenCount } = await middleOutFiltering(items);

    expect(filtered).toEqual(items);
    expect(totalTokenCount).toBe(60);
  });
});

// ----------------------------------------------------------------------------
// noOpFiltering — `forUi` flag.
//
// Regression guard for the Lambda OOM that motivated this code path. The
// webapp's session page calls `noOpFiltering` to materialise message bodies
// for SSR. When a user attaches a multi-GB file (the trigger was a 1.5 GiB
// ZIP), the default LLM-facing `postProcessMessageContent` would download
// every referenced S3 object into the Lambda's heap on every page render,
// blowing past the 1769 MB memory cap. The function would be killed mid-
// stream, the gzip-encoded RSC payload truncated, and browsers would render
// a blank "Application error" with `ERR_CONTENT_DECODING_FAILED` in the
// network tab.
//
// The fix: a `forUi: true` opt-in that keeps `image.source.s3Key` and
// `file.source.s3Key` blocks verbatim, so the webapp can resolve them to
// pre-signed URLs client-side without ever touching S3 from the SSR Lambda.
// ----------------------------------------------------------------------------
describe('noOpFiltering — forUi mode', () => {
  beforeEach(() => {
    mockGetBytesFromKey.mockReset();
  });

  test('preserves image.source.s3Key blocks verbatim and never fetches S3', async () => {
    const item = makeItem('001', 'userMessage', {
      role: 'user',
      content: JSON.stringify([
        { text: 'check this screenshot' },
        { image: { source: { s3Key: 'session-x/abc.png' }, fileName: 'screenshot.png' } },
      ]),
    });

    const { messages } = await noOpFiltering([item], { forUi: true });

    expect(messages).toHaveLength(1);
    const content = (messages[0] as any).content as any[];
    // The text block is unchanged; the image block is passed through with the
    // original `s3Key` intact (and crucially, no `bytes` field was added).
    expect(content).toEqual([
      { text: 'check this screenshot' },
      { image: { source: { s3Key: 'session-x/abc.png' }, fileName: 'screenshot.png' } },
    ]);
    // The whole point of `forUi`: do not pay the S3 round-trip / heap cost.
    expect(mockGetBytesFromKey).not.toHaveBeenCalled();
  });

  test('preserves file.source.s3Key blocks verbatim and never fetches S3', async () => {
    // The original bug report: a 1.5 GiB ZIP attached via webapp made the
    // session unopenable because the SSR Lambda OOMed trying to download it
    // just to render the FileViewer download link.
    const item = makeItem('002', 'userMessage', {
      role: 'user',
      content: JSON.stringify([
        { text: 'have a look at this' },
        { file: { source: { s3Key: 'session-x/big-archive.zip' }, fileName: 'big-archive.zip' } },
      ]),
    });

    const { messages } = await noOpFiltering([item], { forUi: true });

    const content = (messages[0] as any).content as any[];
    expect(content).toEqual([
      { text: 'have a look at this' },
      { file: { source: { s3Key: 'session-x/big-archive.zip' }, fileName: 'big-archive.zip' } },
    ]);
    expect(mockGetBytesFromKey).not.toHaveBeenCalled();
  });

  test('forUi flag propagates into nested toolResult content', async () => {
    // `sendImageToUser` / `sendFileToUser` outputs are stored as `toolResult`
    // blocks whose `content` array carries the attachment. The recursion
    // inside `postProcessMessageContent` must thread `forUi` through, or
    // tool-side attachments would still trigger an S3 fetch and re-introduce
    // the OOM via the back door.
    const item = makeItem('003', 'assistant', {
      role: 'assistant',
      content: JSON.stringify([
        {
          toolResult: {
            toolUseId: 'tool_1',
            content: [{ text: 'sent the image' }, { image: { source: { s3Key: 'session-x/sent.png' } } }],
          },
        },
      ]),
    });

    const { messages } = await noOpFiltering([item], { forUi: true });
    const content = (messages[0] as any).content as any[];
    const tr = content[0].toolResult;
    expect(tr.toolUseId).toBe('tool_1');
    expect(tr.content).toEqual([{ text: 'sent the image' }, { image: { source: { s3Key: 'session-x/sent.png' } } }]);
    expect(mockGetBytesFromKey).not.toHaveBeenCalled();
  });

  test('default mode (forUi omitted) still triggers S3 fetch for image attachments — LLM contract preserved', async () => {
    // The worker agent loop calls `noOpFiltering(items)` (no options) on every
    // turn and relies on the bytes being inlined for Bedrock Converse and on
    // the local-FS path being available for shell tools. This test pins that
    // contract so a future refactor cannot accidentally flip the default.
    //
    // We deliberately use a `.bin` extension so the function takes the sharp
    // re-encode branch — but we only assert that the S3 fetch was attempted.
    // Sharp itself fails on the synthetic byte payload, which is fine: we do
    // not care about the rendered output here, only that the legacy contract
    // ("default mode loads bytes from S3") is still in force.
    mockGetBytesFromKey.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const item = makeItem('004', 'userMessage', {
      role: 'user',
      content: JSON.stringify([{ image: { source: { s3Key: 'session-x/abc.png' } } }]),
    });

    // The result of the call is irrelevant for this assertion; what matters
    // is the side-effect (S3 fetch). Swallow any downstream sharp errors.
    await noOpFiltering([item]).catch(() => undefined);

    expect(mockGetBytesFromKey).toHaveBeenCalledWith('session-x/abc.png');
  });
});

// ---------------------------------------------------------------------------
// The internal-only error message type must be excluded from the default
// (LLM/UI) history view just like communicationLog.
describe('getConversationHistory excludes internalError by default', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockPaginateQuery.mockReset();
  });

  test('internalError is filtered out by default but kept with includeAll', async () => {
    const items = [makeItem('001', 'userMessage'), makeItem('002', 'internalError'), makeItem('003', 'assistant')];
    mockPages(items);

    const { items: def } = await getConversationHistory('worker-1');
    expect(def.map((i) => i.SK)).toEqual(['001', '003']);

    const { items: all } = await getConversationHistory('worker-1', { includeAll: true });
    expect(all.map((i) => i.SK)).toEqual(['001', '002', '003']);
  });
});

// ---------------------------------------------------------------------------
// Ordering guard: the end-of-turn assistant message must sort AFTER every
// intra-turn message. saveConversationHistory({ ensureAfterSK }) clamps the SK
// so a delayed / resurrection-reordered write can never land before an
// intermediate message. REPRO (pre-fix): an intermediate landed 41s after its
// own completion report because SK was a bare Date.now().
describe('getLatestMessageSK + saveConversationHistory ensureAfterSK', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockPaginateQuery.mockReset();
  });

  test('getLatestMessageSK returns the max SK across ALL message types', async () => {
    // W2: getLatestMessageSK now issues a single Query with
    // `ScanIndexForward: false` + `Limit: 1`, so DynamoDB returns only the row
    // with the largest SK. We assert the QueryCommand was shaped correctly
    // (reverse order + limit) AND that the returned SK is propagated.
    mockSend.mockResolvedValueOnce({ Items: [{ SK: '001781934398026' }] });
    const latest = await getLatestMessageSK('worker-1');
    expect(latest).toBe('001781934398026');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = (mockSend.mock.calls[0][0] as any).input;
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(1);
    expect(input.KeyConditionExpression).toBe('PK = :pk');
    expect(input.ExpressionAttributeValues[':pk']).toBe('message-worker-1');
  });

  test('getLatestMessageSK is undefined for an empty session', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    expect(await getLatestMessageSK('worker-1')).toBeUndefined();
  });

  test('getLatestMessageSK is undefined when Items is absent', async () => {
    mockSend.mockResolvedValueOnce({});
    expect(await getLatestMessageSK('worker-1')).toBeUndefined();
  });

  test('ensureAfterSK clamps the final SK strictly after a later intra-turn SK', async () => {
    mockSend.mockResolvedValue({});
    // Simulate the real inversion: an intermediate message SK is far in the
    // future relative to "now" (clock/write-delay/resurrection). The final
    // message must still sort AFTER it.
    const intermediateSK = String(Date.now() + 10_000).padStart(15, '0');
    const saved = await saveConversationHistory(
      'worker-1',
      { role: 'assistant', content: [{ text: 'All work is complete.' }] },
      0,
      'assistant',
      undefined,
      { ensureAfterSK: intermediateSK }
    );
    expect(Number(saved.SK)).toBe(Number(intermediateSK) + 1);
    expect(Number(saved.SK)).toBeGreaterThan(Number(intermediateSK));
  });

  test('ensureAfterSK is a no-op when now is already later than the prior SK', async () => {
    mockSend.mockResolvedValue({});
    const oldSK = String(Date.now() - 60_000).padStart(15, '0');
    const before = Date.now();
    const saved = await saveConversationHistory(
      'worker-1',
      { role: 'assistant', content: [{ text: 'done' }] },
      0,
      'assistant',
      undefined,
      { ensureAfterSK: oldSK }
    );
    // SK is a normal current timestamp, not clamped to oldSK+1.
    expect(Number(saved.SK)).toBeGreaterThanOrEqual(before);
    expect(Number(saved.SK)).toBeGreaterThan(Number(oldSK) + 1);
  });

  test('no ensureAfterSK behaves like the legacy Date.now() path', async () => {
    mockSend.mockResolvedValue({});
    const before = Date.now();
    const saved = await saveConversationHistory(
      'worker-1',
      { role: 'assistant', content: [{ text: 'hi' }] },
      0,
      'assistant'
    );
    expect(Number(saved.SK)).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// W-1' guard: a zero-length image in a toolResult must be neutralized before
// persist, not merely have its S3 upload skipped. A bare `continue` left an
// empty Uint8Array in the content; structuredClone + JSON.stringify collapses
// it to `{}`, which survives a history load as a truthy image block and is
// re-sent to the model every subsequent turn ("Could not process image"
// cascade). This test drives the real preProcessMessageContent via
// saveConversationHistory (DDB mocked) and inspects the persisted content, then
// re-parses it via parseContentBlocks (the real load path) to prove the empty
// image never reaches history.
describe("W-1' zero-length image neutralization (R-2)", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  const extractPersistedContent = (): string => {
    const putCall = mockSend.mock.calls.find((c) => (c[0] as any)?.input?.Item?.content != null);
    expect(putCall).toBeDefined();
    return (putCall![0] as any).input.Item.content as string;
  };

  test('replaces an empty-bytes image block with a benign text marker on persist', async () => {
    mockSend.mockResolvedValue({});
    await saveConversationHistory(
      'worker-1',
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'tool-1',
              content: [{ image: { format: 'png', source: { bytes: new Uint8Array(0) } } }],
            },
          },
        ],
      },
      0,
      'user'
    );

    const persisted = extractPersistedContent();
    // No image block should survive.
    expect(persisted).not.toContain('"image"');
    expect(persisted).toContain('[empty image result skipped]');

    // Load path: parseContentBlocks is what history load uses. The reconstructed
    // toolResult must carry only the text marker, no (truthy) image block.
    const blocks = parseContentBlocks(persisted);
    const tr = blocks[0].toolResult;
    expect(tr.content).toHaveLength(1);
    expect(tr.content[0].image).toBeUndefined();
    expect(tr.content[0].text).toBe('[empty image result skipped]');
  });

  test('a non-empty image is still uploaded to S3 and rewritten to s3Key (regression)', async () => {
    mockSend.mockResolvedValue({});
    await saveConversationHistory(
      'worker-1',
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'tool-2',
              content: [{ image: { format: 'png', source: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } } }],
            },
          },
        ],
      },
      0,
      'user'
    );

    const persisted = extractPersistedContent();
    expect(persisted).toContain('"s3Key"');
    expect(persisted).not.toContain('[empty image result skipped]');
    // bytes must not be persisted inline (moved to S3).
    expect(persisted).not.toContain('"bytes"');
  });
});

// ---------------------------------------------------------------------------
// S1: dedup look-back should query only the recent window via a SK
// KeyCondition, not read the full session history. messageSKFromTimestamp +
// getRecentMessages encapsulate the windowed query.
describe('S1: messageSKFromTimestamp + getRecentMessages (windowed look-back)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockPaginateQuery.mockReset();
  });

  test('messageSKFromTimestamp zero-pads to the 15-char SK format', () => {
    expect(messageSKFromTimestamp(1781934398026)).toBe('001781934398026');
    expect(messageSKFromTimestamp(0)).toBe('000000000000000');
    // Coincides with how SKs are produced on write (String(now).padStart(15,'0')).
    const now = Date.now();
    expect(messageSKFromTimestamp(now)).toBe(String(now).padStart(15, '0'));
  });

  test('issues a SK >= cutoff KeyCondition for the requested window', async () => {
    const rows = [makeItem('001781934357027', 'communicationLog'), makeItem('001781934398026', 'assistant')];
    mockPages(rows);

    const sinceMs = 1781934000000;
    const result = await getRecentMessages('worker-1', sinceMs);

    // The query is scoped to the recent window, not the full PK.
    expect(mockPaginateQuery).toHaveBeenCalledTimes(1);
    const queryInput = mockPaginateQuery.mock.calls[0][1];
    expect(queryInput.KeyConditionExpression).toBe('PK = :pk AND SK >= :cutoff');
    expect(queryInput.ExpressionAttributeValues[':pk']).toBe('message-worker-1');
    expect(queryInput.ExpressionAttributeValues[':cutoff']).toBe('001781934000000');

    // All rows in the window are returned verbatim (no messageType filtering;
    // the dedup caller filters in memory).
    expect(result.map((i) => i.SK)).toEqual(['001781934357027', '001781934398026']);
  });

  test('clamps a negative sinceMs to a valid 15-char cutoff', async () => {
    mockPages([]);
    await getRecentMessages('worker-1', -5000);
    const queryInput = mockPaginateQuery.mock.calls[0][1];
    expect(queryInput.ExpressionAttributeValues[':cutoff']).toBe('000000000000000');
  });
});

// ---------------------------------------------------------------------------
// Edge case: postProcessMessageContent must not throw a server-side exception
// when a row's `content` is not a JSON array (malformed legacy row / future
// code path / plain text). parseContentBlocks falls back to a single text
// block. We exercise it directly and end-to-end through noOpFiltering.
describe('parseContentBlocks (defensive JSON.parse)', () => {
  test('parses a normal JSON-stringified ContentBlock array', () => {
    expect(parseContentBlocks('[{"text":"hi"}]')).toEqual([{ text: 'hi' }]);
  });

  test('falls back to a single text block for non-JSON plain text', () => {
    expect(parseContentBlocks('just plain text, not json')).toEqual([{ text: 'just plain text, not json' }]);
  });

  test('falls back to a single text block for a non-array JSON value', () => {
    expect(parseContentBlocks('"a bare json string"')).toEqual([{ text: '"a bare json string"' }]);
    expect(parseContentBlocks('42')).toEqual([{ text: '42' }]);
    expect(parseContentBlocks('{"text":"obj-not-array"}')).toEqual([{ text: '{"text":"obj-not-array"}' }]);
  });

  test('empty array stays an empty array', () => {
    expect(parseContentBlocks('[]')).toEqual([]);
  });
});

describe('postProcessMessageContent tolerates non-JSON content (no server exception)', () => {
  beforeEach(() => {
    mockGetBytesFromKey.mockReset();
  });

  test('noOpFiltering renders plain-text content as a single text block instead of throwing', async () => {
    // A row whose `content` is plain text (not a JSON array). Before the fix,
    // JSON.parse threw and tanked the turn / page render.
    const item = makeItem('001', 'assistant', { role: 'assistant', content: 'oops, plain text leaked in' });

    const { messages } = await noOpFiltering([item]);

    expect(messages).toHaveLength(1);
    expect((messages[0] as any).content).toEqual([{ text: 'oops, plain text leaked in' }]);
    expect(mockGetBytesFromKey).not.toHaveBeenCalled();
  });
});

describe('ensureImageWithinBounds', () => {
  test('image within bounds is returned unchanged', async () => {
    const sharp = (await import('sharp')).default;
    const small = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await ensureImageWithinBounds(new Uint8Array(small), { format: 'png' });
    expect(result.length).toBe(small.length);
  });

  test('oversized image is downscaled', async () => {
    const sharp = (await import('sharp')).default;
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .png()
      .toBuffer();

    const result = await ensureImageWithinBounds(new Uint8Array(big), { format: 'png' });
    const meta = await sharp(Buffer.from(result)).metadata();
    expect(meta.width).toBeLessThanOrEqual(1568);
    expect(meta.height).toBeLessThanOrEqual(1568);
  });

  test('oversized image with mimeType is downscaled', async () => {
    const sharp = (await import('sharp')).default;
    const big = await sharp({
      create: { width: 2500, height: 1800, channels: 3, background: { r: 64, g: 64, b: 64 } },
    })
      .jpeg()
      .toBuffer();

    const result = await ensureImageWithinBounds(new Uint8Array(big), { mimeType: 'image/jpeg' });
    const meta = await sharp(Buffer.from(result)).metadata();
    expect(meta.width).toBeLessThanOrEqual(1568);
    expect(meta.height).toBeLessThanOrEqual(1568);
  });

  test('unrecognized format buffer is returned unchanged (graceful)', async () => {
    const corruptPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff]);
    const result = await ensureImageWithinBounds(corruptPng, { format: 'png' });
    expect(result).toBe(corruptPng);
  });
});

// ---------------------------------------------------------------------------
// W3: materializeImageBlock — verify real behavior (naming, preview sizing,
// caching). Uses real sharp processing against synthetic image buffers.
describe('materializeImageBlock', () => {
  beforeEach(() => {
    mockGetBytesFromKey.mockReset();
  });

  test('produces original and preview paths with correct naming from s3Key', async () => {
    const sharp = (await import('sharp')).default;
    const pngBuf = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .png()
      .toBuffer();
    mockGetBytesFromKey.mockResolvedValue(new Uint8Array(pngBuf));

    const { materializeImageBlock } = await import('./messages');
    const result = await materializeImageBlock('worker-1/abc123.png');

    expect(result.fileName).toBe('abc123.png');
    expect(result.originalPath).toContain('abc123.png');
    expect(result.previewPath).toContain('.jpeg');
    expect(result.s3Uri).toBe('s3://test-bucket/worker-1/abc123.png');
  });

  test('preview is within 1568px bounds and is JPEG', async () => {
    const sharp = (await import('sharp')).default;
    const bigPng = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 50, g: 50, b: 50 } },
    })
      .png()
      .toBuffer();
    mockGetBytesFromKey.mockResolvedValue(new Uint8Array(bigPng));

    const { materializeImageBlock } = await import('./messages');
    const result = await materializeImageBlock('worker-1/big-photo.png');

    const { readFileSync } = await import('fs');
    const previewBuf = readFileSync(result.previewPath);
    const meta = await sharp(previewBuf).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBeLessThanOrEqual(1568);
    expect(meta.height).toBeLessThanOrEqual(1568);
  });

  test('caches results for the same s3Key', async () => {
    const sharp = (await import('sharp')).default;
    const pngBuf = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    mockGetBytesFromKey.mockResolvedValue(new Uint8Array(pngBuf));

    const { materializeImageBlock } = await import('./messages');
    const result1 = await materializeImageBlock('worker-1/cached.png');
    const result2 = await materializeImageBlock('worker-1/cached.png');

    expect(result1.originalPath).toBe(result2.originalPath);
    expect(result1.previewPath).toBe(result2.previewPath);
    expect(mockGetBytesFromKey).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// W3: postProcessMessageContent (non-forUi) — top-level images become text,
// toolResult images remain as bytes.
describe('postProcessMessageContent image handling (non-forUi)', () => {
  beforeEach(() => {
    mockGetBytesFromKey.mockReset();
  });

  test('top-level image is converted to text with original path, preview path, and readLocalImage instruction', async () => {
    const sharp = (await import('sharp')).default;
    const pngBuf = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .png()
      .toBuffer();
    mockGetBytesFromKey.mockResolvedValue(new Uint8Array(pngBuf));

    const item = makeItem('010', 'userMessage', {
      role: 'user',
      content: JSON.stringify([{ text: 'look at this' }, { image: { source: { s3Key: 'w1/photo.png' } } }]),
    });

    const { messages } = await noOpFiltering([item]);
    const content = (messages[0] as any).content as any[];

    expect(content).toHaveLength(2);
    expect(content[0].text).toBe('look at this');
    expect(content[1].text).toContain('the image "photo.png" is available as a resized preview at');
    expect(content[1].text).toContain('s3://test-bucket/w1/photo.png');
    expect(content[1].text).toContain('readLocalImage');
    expect(content[1].text).toContain('preview');
    expect(content[1].image).toBeUndefined();
  });

  test('toolResult image is kept as image bytes (not flattened to text)', async () => {
    const sharp = (await import('sharp')).default;
    const pngBuf = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();
    mockGetBytesFromKey.mockResolvedValue(new Uint8Array(pngBuf));

    const item = makeItem('011', 'toolResult', {
      role: 'user',
      content: JSON.stringify([
        {
          toolResult: {
            toolUseId: 'tool_1',
            content: [
              { text: 'screenshot captured' },
              { image: { source: { s3Key: 'w1/screenshot.png' }, format: 'png' } },
            ],
          },
        },
      ]),
    });

    const { messages } = await noOpFiltering([item]);
    const content = (messages[0] as any).content as any[];
    const tr = content[0].toolResult;

    expect(tr.content).toHaveLength(2);
    expect(tr.content[0].text).toBe('screenshot captured');
    expect(tr.content[1].image).toBeDefined();
    expect(tr.content[1].image.source.bytes).toBeDefined();
    expect(tr.content[1].image.format).toBe('png');
    expect(tr.content[1].text).toBeUndefined();
  });

  test('toolResult image bytes are memoized across separate calls (same s3Key)', async () => {
    const sharp = (await import('sharp')).default;
    const pngBuf = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    mockGetBytesFromKey.mockResolvedValue(new Uint8Array(pngBuf));

    const makeToolResultItem = (sk: string) =>
      makeItem(sk, 'toolResult', {
        role: 'user',
        content: JSON.stringify([
          {
            toolResult: {
              toolUseId: `tool_${sk}`,
              content: [{ image: { source: { s3Key: 'w1/cached-tool-img.png' }, format: 'png' } }],
            },
          },
        ]),
      });

    // First call populates cache
    await noOpFiltering([makeToolResultItem('020')]);
    expect(mockGetBytesFromKey).toHaveBeenCalledTimes(1);

    // Second call should hit cache — no additional S3 fetch
    await noOpFiltering([makeToolResultItem('021')]);
    expect(mockGetBytesFromKey).toHaveBeenCalledTimes(1);
    expect(mockGetBytesFromKey).toHaveBeenCalledWith('w1/cached-tool-img.png');
  });
});

// ---------------------------------------------------------------------------
// sendSystemMessage — lastMessageUpdate emit + mention strip + best-effort
// ---------------------------------------------------------------------------

import { sendWebappEvent } from './events';
import { sendMessageToSlack } from './slack';

const mockWebappEvent = sendWebappEvent as ReturnType<typeof vi.fn>;
const mockSlack = sendMessageToSlack as ReturnType<typeof vi.fn>;

describe('sendSystemMessage — lastMessageUpdate', () => {
  beforeEach(() => {
    mockWebappEvent.mockReset();
    mockSlack.mockReset();
    mockUpdateSessionLastMessage.mockReset();
    mockUpdateSessionLastMessage.mockResolvedValue(undefined);
  });

  test('emits lastMessageUpdate with preview slice(0,500) when messageSK is provided', async () => {
    await sendSystemMessage('w1', 'hello world', false, false, 'sk-123');
    const lastMsgCalls = mockWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(lastMsgCalls.length).toBe(1);
    expect(lastMsgCalls[0][0]).toBe('w1');
    expect(lastMsgCalls[0][1].lastMessage).toBe('hello world');
    expect(mockUpdateSessionLastMessage).toHaveBeenCalledWith('w1', 'hello world');
  });

  test('strips Slack mention prefix from preview', async () => {
    await sendSystemMessage('w1', '<@U12ABC> error occurred', false, false, 'sk-456');
    const lastMsgCalls = mockWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(lastMsgCalls[0][1].lastMessage).toBe('error occurred');
    expect(mockUpdateSessionLastMessage).toHaveBeenCalledWith('w1', 'error occurred');
  });

  test('emits lastMessageUpdate even when skipWebappEmit=true (if messageSK provided)', async () => {
    await sendSystemMessage('w1', 'skipped bubble', false, true, 'sk-789');
    // bubble NOT emitted
    const bubbleCalls = mockWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'message');
    expect(bubbleCalls.length).toBe(0);
    // lastMessageUpdate still emitted (message is persisted)
    const lastMsgCalls = mockWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(lastMsgCalls.length).toBe(1);
    expect(mockUpdateSessionLastMessage).toHaveBeenCalledTimes(1);
  });

  test('does NOT emit lastMessageUpdate when no messageSK (non-persisted lifecycle message)', async () => {
    await sendSystemMessage('w1', 'Going to sleep mode. You can wake me up at any time.');
    // No lastMessageUpdate — message is transient, not persisted to DDB
    const lastMsgCalls = mockWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'lastMessageUpdate');
    expect(lastMsgCalls.length).toBe(0);
    expect(mockUpdateSessionLastMessage).not.toHaveBeenCalled();
    // Bubble + Slack still delivered
    const bubbleCalls = mockWebappEvent.mock.calls.filter((c: any[]) => c[1].type === 'message');
    expect(bubbleCalls.length).toBe(1);
    expect(mockSlack).toHaveBeenCalledTimes(1);
  });

  test('best-effort: DDB failure does not throw', async () => {
    mockUpdateSessionLastMessage.mockRejectedValue(new Error('ddb down'));
    // Must not throw (messageSK provided to exercise the try/catch path)
    await expect(sendSystemMessage('w1', 'test', false, false, 'sk-err')).resolves.not.toThrow();
    // Slack still delivered
    expect(mockSlack).toHaveBeenCalledTimes(1);
  });

  test('truncates preview to 500 chars', async () => {
    const longMsg = 'x'.repeat(1000);
    await sendSystemMessage('w1', longMsg, false, false, 'sk-trunc');
    expect(mockUpdateSessionLastMessage).toHaveBeenCalledWith('w1', 'x'.repeat(500));
  });
});
