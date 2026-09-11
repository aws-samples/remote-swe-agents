/**
 * toStrandsTool adapter tests. Verifies name/description resolution, input
 * pass-through, dep injection (workerId/toolUseId), and result flattening
 * (string + ToolResultContentBlock[] → scalar string).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { ToolResultContentBlock } from '@aws-sdk/client-bedrock-runtime';
import {
  toStrandsTool,
  sanitizeToolName,
  REPORT_TIMER_RESET_TOOLS,
  bedrockToolResultToSdkContent,
  mcpContentToSdkBlocks,
  type RemoteSweToolLike,
} from './to-strands-tool';

function makeTool<Input>(
  overrides: Partial<RemoteSweToolLike<Input>> & { handler: RemoteSweToolLike<Input>['handler'] }
): RemoteSweToolLike<Input> {
  return {
    name: 'echo',
    schema: z.object({ text: z.string() }) as unknown as RemoteSweToolLike<Input>['schema'],
    toolSpec: async () => ({ description: 'Echo the input text' }),
    ...overrides,
  };
}

const deps = { workerId: 'worker-1', globalPreferences: {}, cancellationToken: undefined };

describe('sanitizeToolName', () => {
  it('passes through valid names unchanged', () => {
    expect(sanitizeToolName('echo')).toBe('echo');
    expect(sanitizeToolName('my-tool_v2')).toBe('my-tool_v2');
  });

  it('replaces spaces and special characters with underscores', () => {
    expect(sanitizeToolName('Send Message To User')).toBe('Send_Message_To_User');
    expect(sanitizeToolName('tool@v1.2')).toBe('tool_v1_2');
  });
});

describe('toStrandsTool', () => {
  it('resolves name + description from the remote-swe tool', async () => {
    const t = await toStrandsTool(makeTool({ handler: async () => 'ok' }), deps);
    expect(t.name).toBe('echo');
    expect(t.description).toBe('Echo the input text');
  });

  it('sanitizes tool names with spaces ( regression)', async () => {
    const t = await toStrandsTool(makeTool({ name: 'Send Message To User', handler: async () => 'sent' }), deps);
    expect(t.name).toBe('Send_Message_To_User');
  });

  it('injects workerId + toolUseId and returns a wrapped result', async () => {
    let seen: { workerId?: string; toolUseId?: string } = {};
    const t = await toStrandsTool(
      makeTool<{ text: string }>({
        handler: async (input, ctxDeps) => {
          seen = { workerId: ctxDeps.workerId, toolUseId: ctxDeps.toolUseId };
          return `echoed: ${input.text}`;
        },
      }),
      deps
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (t as any).invoke({ text: 'hi' }, { toolUse: { toolUseId: 'call-9' } });
    expect(out).toContain('<result>');
    expect(out).toContain('echoed: hi');
    expect(seen.workerId).toBe('worker-1');
    expect(seen.toolUseId).toBe('call-9');
  });

  it('returns SDK-native content array for ToolResultContentBlock[] (no renderToolResult wrap)', async () => {
    const blocks: ToolResultContentBlock[] = [
      { text: 'line1' },
      { image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } },
    ];
    const t = await toStrandsTool(makeTool({ handler: async () => blocks }), deps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (t as any).invoke({ text: 'x' }, { toolUse: { toolUseId: 'c' } });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ text: 'line1' });
    expect(out[1]).toHaveProperty('image');
  });
});

describe('forceReport timer', () => {
  it('inserts nudge command after 5 minutes without communication tool use', async () => {
    const forceReportState = { lastReportedTime: Date.now() - 301_000, parentSessionId: undefined };
    const depsWithTimer = { ...deps, forceReportState };
    const t = await toStrandsTool(makeTool({ handler: async () => 'done' }), depsWithTimer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (t as any).invoke({ text: 'x' }, { toolUse: { toolUseId: 'c' } });
    expect(out).toContain('Long time has passed');
    expect(out).toContain('sendMessageToUser');
  });

  it('resets timer on communication tool → no nudge on subsequent tool', async () => {
    const forceReportState = { lastReportedTime: Date.now() - 301_000, parentSessionId: undefined };
    const depsWithTimer = { ...deps, forceReportState };
    const commTool = await toStrandsTool(
      makeTool({ name: 'sendMessageToUser', handler: async () => 'sent' }),
      depsWithTimer
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (commTool as any).invoke({ text: 'hi' }, { toolUse: { toolUseId: 'c1' } });
    // Timer was reset — next non-comm tool should NOT get nudge
    const regularTool = await toStrandsTool(makeTool({ handler: async () => 'result' }), depsWithTimer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (regularTool as any).invoke({ text: 'x' }, { toolUse: { toolUseId: 'c2' } });
    expect(out).not.toContain('Long time has passed');
  });

  it('reset list derives from actual tool objects (drift detection)', () => {
    expect(REPORT_TIMER_RESET_TOOLS.has(sanitizeToolName('sendMessageToUser'))).toBe(true);
    expect(REPORT_TIMER_RESET_TOOLS.has(sanitizeToolName('sendMessageToAgent'))).toBe(true);
    expect(REPORT_TIMER_RESET_TOOLS.has(sanitizeToolName('acknowledgeAgent'))).toBe(true);
    expect(REPORT_TIMER_RESET_TOOLS.size).toBe(3);
  });
});

describe('multimodal passthrough', () => {
  it('image block from handler → SDK native content (bytes round-trip)', async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const blocks: ToolResultContentBlock[] = [
      { text: 'screenshot captured' },
      { image: { format: 'png', source: { bytes: imageBytes } } },
    ];
    const t = await toStrandsTool(makeTool({ handler: async () => blocks }), deps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (t as any).invoke({ text: 'x' }, { toolUse: { toolUseId: 'img-1' } });
    // SDK wraps the array as ToolResultBlock content — invoke returns raw value
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ text: 'screenshot captured' });
    expect(out[1]).toHaveProperty('image');
    expect(out[1].image.format).toBe('png');
    expect(out[1].image.source.bytes).toEqual(imageBytes);
  });

  it('bedrockToolResultToSdkContent handles s3 source for image', () => {
    const blocks: ToolResultContentBlock[] = [
      {
        image: { format: 'jpeg', source: { s3Location: { uri: 's3://bucket/key.jpg', bucketOwner: '123456789012' } } },
      } as any,
    ];
    const result = bedrockToolResultToSdkContent(blocks);
    expect(result[0]).toEqual({
      image: {
        format: 'jpeg',
        source: { location: { type: 's3', uri: 's3://bucket/key.jpg', bucketOwner: '123456789012' } },
      },
    });
  });
});

describe('mcpContentToSdkBlocks', () => {
  const fakeNormalize = (mime: string | undefined) => (mime === 'image/png' ? 'png' : 'jpeg');

  it('converts text + image MCP content to SDK blocks with base64 decode', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const content = [
      { type: 'text', text: 'captured screenshot' },
      { type: 'image', mimeType: 'image/png', data: pngBytes.toString('base64') },
    ];
    const result = mcpContentToSdkBlocks(content, fakeNormalize);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ text: 'captured screenshot' });
    expect((result[1] as any).image.format).toBe('png');
    expect(Buffer.from((result[1] as any).image.source.bytes).equals(pngBytes)).toBe(true);
  });

  it('produces short placeholder for unknown content types ( token explosion fix)', () => {
    const content = [{ type: 'audio', data: 'x'.repeat(10000) }];
    const result = mcpContentToSdkBlocks(content, fakeNormalize);
    expect(result).toHaveLength(1);
    expect((result[0] as any).text).toBe('[unsupported MCP content type: audio]');
    expect((result[0] as any).text.length).toBeLessThan(100);
  });
});
