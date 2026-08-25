/**
 * Golden round-trip tests for the Strands / Bedrock message converter.
 * Verifies that text / toolUse / toolResult / reasoning / image (bytes + s3Key)
 * survive Bedrock → Strands → Bedrock without loss, so the on-disk
 * (Bedrock-wire) format never drifts when the Strands loop persists.
 */
import { describe, it, expect } from 'vitest';
import type { Message as BedrockMessage } from '@aws-sdk/client-bedrock-runtime';
import {
  bedrockToStrandsMessage,
  strandsToBedrockMessage,
  strandsBlockToBedrock,
  type ConverterS3Context,
} from './message-converter';

const ctx: ConverterS3Context = { bucket: 'remote-swe-bucket' };

/** Bedrock → Strands → Bedrock; expect deep equality with the original. */
function roundTrip(msg: BedrockMessage): BedrockMessage {
  return strandsToBedrockMessage(bedrockToStrandsMessage(msg, ctx), ctx);
}

describe('message-converter round-trip', () => {
  it('preserves a plain text assistant message', () => {
    const msg: BedrockMessage = { role: 'assistant', content: [{ text: 'hello world' }] };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('preserves a multi-block toolUse batch', () => {
    const msg: BedrockMessage = {
      role: 'assistant',
      content: [
        { text: 'let me check' },
        { toolUse: { toolUseId: 'call-1', name: 'fs_read', input: { path: '/a.txt' } } },
        { toolUse: { toolUseId: 'call-2', name: 'execute_bash', input: { command: 'ls' } } },
      ],
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('preserves a toolResult batch (success implicit, error explicit)', () => {
    const msg: BedrockMessage = {
      role: 'user',
      content: [
        { toolResult: { toolUseId: 'call-1', content: [{ text: 'file contents' }] } },
        { toolResult: { toolUseId: 'call-2', content: [{ text: 'boom' }], status: 'error' } },
      ],
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('preserves a reasoning block with signature', () => {
    const msg: BedrockMessage = {
      role: 'assistant',
      content: [
        { reasoningContent: { reasoningText: { text: 'thinking...', signature: 'sig-abc' } } },
        { text: 'answer' },
      ],
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('preserves an image block with raw bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const msg: BedrockMessage = {
      role: 'user',
      content: [{ image: { format: 'png', source: { bytes } } }],
    };
    const rt = roundTrip(msg);
    expect(rt.role).toBe('user');
    const img = (rt.content?.[0] as { image?: { format?: string; source?: { bytes?: Uint8Array } } }).image;
    expect(img?.format).toBe('png');
    expect(Array.from(img?.source?.bytes ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('preserves an s3Key image through the s3:// URI round-trip (with known bucket)', () => {
    const msg: BedrockMessage = {
      role: 'user',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: [{ image: { format: 'jpeg', source: { s3Key: 'worker-1/abc.jpeg' } as any } }],
    };
    const rt = roundTrip(msg);
    const img = (rt.content?.[0] as { image?: { format?: string; source?: { s3Key?: string } } }).image;
    expect(img?.format).toBe('jpeg');
    expect(img?.source?.s3Key).toBe('worker-1/abc.jpeg');
  });

  it('preserves an image nested inside a toolResult', () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const msg: BedrockMessage = {
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: 'call-x',
            content: [{ text: 'see image' }, { image: { format: 'gif', source: { bytes } } }],
          },
        },
      ],
    };
    const rt = roundTrip(msg);
    const tr = (rt.content?.[0] as { toolResult?: { content?: unknown[] } }).toolResult;
    expect(tr?.content?.length).toBe(2);
  });

  it('drops a cachePoint block on the Strands→Bedrock path (never persisted)', () => {
    // A Strands message carrying a cachePoint should serialise without it.
    const strandsMsg = {
      role: 'assistant' as const,
      content: [{ text: 'x' }, { cachePoint: { cacheType: 'default' as const } }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bedrock = strandsToBedrockMessage(strandsMsg as any, ctx);
    expect(bedrock.content).toEqual([{ text: 'x' }]);
  });

  it('preserves a json block nested inside a toolResult (round-trip)', () => {
    const msg: BedrockMessage = {
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: 'call-j',
            content: [{ text: 'result' }, { json: { ok: true, items: [1, 2, 3] } }],
          },
        },
      ],
    };
    const rt = roundTrip(msg);
    const tr = (rt.content?.[0] as { toolResult?: { content?: unknown[] } }).toolResult;
    expect(tr?.content).toEqual([{ text: 'result' }, { json: { ok: true, items: [1, 2, 3] } }]);
  });

  it('maps an absent toolResult status to success (Strands requires explicit status)', () => {
    const msg: BedrockMessage = {
      role: 'user',
      content: [{ toolResult: { toolUseId: 'c', content: [{ text: 'ok' }] } }],
    };
    const strands = bedrockToStrandsMessage(msg, ctx);
    const tr = (strands.content[0] as { toolResult?: { status?: string } }).toolResult;
    expect(tr?.status).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// rewrite: SDK-level round-trip tests (exercises Message.fromJSON which
// internally calls contentBlockFromData — old opaque marker caused throw here)
// ---------------------------------------------------------------------------
import { Message } from '@strands-agents/sdk';

describe(' native block support — SDK Message round-trip', () => {
  it('document block survives converter → Message.fromJSON → toJSON → converter', () => {
    const bedrockMsg: BedrockMessage = {
      role: 'user',
      content: [
        {
          document: {
            format: 'pdf',
            name: 'design-doc',
            source: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
          },
        } as any,
      ],
    };
    // Bedrock → Strands MessageData
    const strandsData = bedrockToStrandsMessage(bedrockMsg, ctx);
    expect(strandsData.content).toHaveLength(1);
    expect('document' in strandsData.content[0]!).toBe(true);

    // MessageData → live Message (contentBlockFromData runs here — old marker threw)
    const liveMsg = Message.fromJSON(strandsData);
    expect(liveMsg.content).toHaveLength(1);

    // live Message → toJSON → MessageData
    const reserialized = liveMsg.toJSON();
    expect('document' in reserialized.content[0]!).toBe(true);

    // After SDK toJSON, bytes are base64-encoded. Verify structure + content (base64 is expected).
    const backToBedrock = strandsToBedrockMessage(reserialized, ctx);
    const doc = (backToBedrock.content?.[0] as any)?.document;
    expect(doc.format).toBe('pdf');
    expect(doc.name).toBe('design-doc');
    // Bytes survive as base64 string through SDK serialization; verify decodable to original
    const rawBytes = doc.source.bytes;
    const decoded = typeof rawBytes === 'string' ? Buffer.from(rawBytes, 'base64') : Buffer.from(rawBytes);
    expect(Array.from(decoded)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('video block survives SDK Message round-trip (s3Location)', () => {
    const bedrockMsg: BedrockMessage = {
      role: 'user',
      content: [
        {
          video: {
            format: 'mp4',
            source: { s3Location: { uri: 's3://my-bucket/video.mp4' } },
          },
        } as any,
      ],
    };
    const strandsData = bedrockToStrandsMessage(bedrockMsg, ctx);
    const liveMsg = Message.fromJSON(strandsData);
    const reserialized = liveMsg.toJSON();
    const backToBedrock = strandsToBedrockMessage(reserialized, ctx);
    const vid = (backToBedrock.content?.[0] as any)?.video;
    expect(vid.format).toBe('mp4');
    expect(vid.source.s3Location.uri).toBe('s3://my-bucket/video.mp4');
  });

  it('guardContent block survives SDK Message round-trip', () => {
    const bedrockMsg: BedrockMessage = {
      role: 'user',
      content: [
        {
          guardContent: {
            text: { text: 'verify this', qualifiers: ['grounding_source'] },
          },
        } as any,
      ],
    };
    const strandsData = bedrockToStrandsMessage(bedrockMsg, ctx);
    const liveMsg = Message.fromJSON(strandsData);
    const reserialized = liveMsg.toJSON();
    const backToBedrock = strandsToBedrockMessage(reserialized, ctx);
    const gc = (backToBedrock.content?.[0] as any)?.guardContent;
    expect(gc.text.text).toBe('verify this');
    expect(gc.text.qualifiers).toEqual(['grounding_source']);
  });

  it('unknown block type (e.g. audio) is silently dropped, not thrown', () => {
    const bedrockMsg: BedrockMessage = {
      role: 'assistant',
      content: [{ text: 'here is audio' }, { audio: { format: 'mp3', source: { bytes: new Uint8Array([1]) } } } as any],
    };
    const strandsData = bedrockToStrandsMessage(bedrockMsg, ctx);
    // audio is dropped, only text survives
    expect(strandsData.content).toHaveLength(1);
    expect('text' in strandsData.content[0]!).toBe(true);
  });

  describe('reasoning redactedContent round-trip', () => {
    it('forward: Bedrock reasoningContent.redactedContent → Strands reasoning.redactedContent', () => {
      const redacted = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const bedrockMsg: BedrockMessage = {
        role: 'assistant',
        content: [{ reasoningContent: { redactedContent: redacted } } as any],
      };
      const strandsData = bedrockToStrandsMessage(bedrockMsg, ctx);
      const reasoning = (strandsData.content[0] as { reasoning?: { redactedContent?: Uint8Array } }).reasoning;
      expect(reasoning?.redactedContent).toBeInstanceOf(Uint8Array);
      expect(Array.from(reasoning!.redactedContent!)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it('reverse: Strands reasoning.redactedContent (Uint8Array) → Bedrock reasoningContent.redactedContent', () => {
      const redacted = new Uint8Array([0x01, 0x02, 0x03]);
      const block = { reasoning: { redactedContent: redacted } };
      const result = strandsBlockToBedrock(block as any, ctx);
      const rc = (result as any)?.reasoningContent;
      expect(rc.redactedContent).toBeInstanceOf(Uint8Array);
      expect(Array.from(rc.redactedContent)).toEqual([0x01, 0x02, 0x03]);
      expect(rc.reasoningText).toBeUndefined();
    });

    it('reverse: base64-string redactedContent (after SDK toJSON) is decoded to Uint8Array', () => {
      const redacted = new Uint8Array([0xca, 0xfe]);
      const base64Str = Buffer.from(redacted).toString('base64');
      const block = { reasoning: { redactedContent: base64Str } };
      const result = strandsBlockToBedrock(block as any, ctx);
      const rc = (result as any)?.reasoningContent;
      expect(rc.redactedContent).toBeInstanceOf(Buffer);
      expect(Array.from(rc.redactedContent)).toEqual([0xca, 0xfe]);
    });

    it('normal reasoning (text + signature) still maps to reasoningText (regression)', () => {
      const block = { reasoning: { text: 'thinking', signature: 'sig-abc' } };
      const result = strandsBlockToBedrock(block as any, ctx);
      const rc = (result as any)?.reasoningContent;
      expect(rc.reasoningText.text).toBe('thinking');
      expect(rc.reasoningText.signature).toBe('sig-abc');
      expect(rc.redactedContent).toBeUndefined();
    });

    it('survives full SDK Message round-trip (redactedContent bytes preserved)', () => {
      const redacted = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
      const bedrockMsg: BedrockMessage = {
        role: 'assistant',
        content: [{ reasoningContent: { redactedContent: redacted } } as any],
      };
      const strandsData = bedrockToStrandsMessage(bedrockMsg, ctx);
      const liveMsg = Message.fromJSON(strandsData);
      const reserialized = liveMsg.toJSON();
      const backToBedrock = strandsToBedrockMessage(reserialized, ctx);
      const rc = (backToBedrock.content?.[0] as any)?.reasoningContent;
      const decoded =
        rc.redactedContent instanceof Uint8Array || Buffer.isBuffer(rc.redactedContent)
          ? Buffer.from(rc.redactedContent)
          : Buffer.from(rc.redactedContent, 'base64');
      expect(Array.from(decoded)).toEqual([0x11, 0x22, 0x33, 0x44]);
    });
  });

  describe('strandsBlockToBedrock base64 string decode (E2E fix)', () => {
    it('decodes base64-encoded image bytes after SDK toJSON serialization', () => {
      const originalBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
      const base64Str = Buffer.from(originalBytes).toString('base64');
      // Simulate SDK toJSON output: bytes field is a base64 string
      const block = { image: { format: 'png', source: { bytes: base64Str } } };
      const result = strandsBlockToBedrock(block as any, ctx);
      const imgSource = (result as any)?.image?.source;
      expect(imgSource.bytes).toBeInstanceOf(Buffer);
      expect(Array.from(imgSource.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('decodes base64-encoded video bytes after SDK toJSON serialization', () => {
      const originalBytes = new Uint8Array([0x00, 0x00, 0x00, 0x1c]);
      const base64Str = Buffer.from(originalBytes).toString('base64');
      const block = { video: { format: 'mp4', source: { bytes: base64Str } } };
      const result = strandsBlockToBedrock(block as any, ctx);
      const vidSource = (result as any)?.video?.source;
      expect(vidSource.bytes).toBeInstanceOf(Buffer);
      expect(Array.from(vidSource.bytes)).toEqual([0x00, 0x00, 0x00, 0x1c]);
    });

    it('decodes base64-encoded document bytes after SDK toJSON serialization', () => {
      const originalBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
      const base64Str = Buffer.from(originalBytes).toString('base64');
      const block = { document: { format: 'pdf', name: 'test.pdf', source: { bytes: base64Str } } };
      const result = strandsBlockToBedrock(block as any, ctx);
      const docSource = (result as any)?.document?.source;
      expect(docSource.bytes).toBeInstanceOf(Buffer);
      expect(Array.from(docSource.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    });

    it('passes through Uint8Array bytes unchanged (no double-decode)', () => {
      const originalBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const block = { image: { format: 'png', source: { bytes: originalBytes } } };
      const result = strandsBlockToBedrock(block as any, ctx);
      const imgSource = (result as any)?.image?.source;
      expect(imgSource.bytes).toBe(originalBytes); // same reference
    });
  });
});
