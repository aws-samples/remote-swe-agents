/**
 * Strands ↔ remote-swe (Bedrock-wire) message converter
 * =====================================================
 * remote-swe persists conversation history as Bedrock `Message.content`
 * (`@aws-sdk/client-bedrock-runtime`) JSON in DynamoDB (see
 * packages/agent-core/src/lib/messages.ts). The Strands migration keeps that
 * on-disk format byte-compatible (DESIGN §3.5): persistence still goes through
 * the existing messages.ts helpers, and this module maps between Strands'
 * `MessageData` / `ContentBlockData` shape and the Bedrock `Message` shape at
 * the backend boundary.
 *
 * Direction:
 *  - `bedrockToStrands*`: stored/Bedrock → Strands (for loading history into
 *  `new Agent({ messages })`).
 *  - `strandsToBedrock*`: Strands → stored/Bedrock (for persisting the assistant
 *  message the Strands loop produced, via the existing saveConversationHistory).
 *
 * Round-trip fidelity: text / toolUse / toolResult / reasoning (text, signature
 * and redactedContent) / image (bytes + s3Key) / video / document / guardContent /
 * citations are mapped in both directions and survive convert→persist→load→convert.
 * Round-trip tests cover text / toolUse / toolResult / reasoning / image / video /
 * document / guardContent; the SDK natively supports all these block types, so no
 * opaque passthrough markers are needed (rewrite).
 *
 * NOTE: cachePoint blocks are NOT round-tripped through storage — they are a
 * per-call caching hint inserted just before the model call (inside
 * RemoteSweBedrockModel.stream, DESIGN §3.4), never persisted. The converter
 * drops them on the Strands→Bedrock path if present.
 */
import type {
  ContentBlock as BedrockContentBlock,
  Message as BedrockMessage,
  ToolResultContentBlock as BedrockToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { MessageData, ContentBlockData, Role } from '@strands-agents/sdk';

/** Optional S3 bucket used to expand a bare `s3Key` into a Strands `s3://` URI. */
export interface ConverterS3Context {
  bucket?: string;
}

/** Bedrock ImageFormat ⊂ Strands ImageFormat; both use 'png'|'jpeg'|'gif'|'webp'. */
type ImgFormat = 'png' | 'jpeg' | 'gif' | 'webp';

function s3KeyToUri(s3Key: string, ctx?: ConverterS3Context): string {
  // stored form is a bucket-relative key; Strands wants a full s3:// URI.
  if (s3Key.startsWith('s3://')) return s3Key;
  const bucket = ctx?.bucket ?? '';
  return bucket ? `s3://${bucket}/${s3Key}` : `s3://${s3Key}`;
}

function s3UriToKey(uri: string, ctx?: ConverterS3Context): string {
  // inverse of s3KeyToUri: strip the s3://bucket/ prefix back to a bare key.
  if (!uri.startsWith('s3://')) return uri;
  const rest = uri.slice('s3://'.length);
  const bucket = ctx?.bucket;
  if (bucket && rest.startsWith(`${bucket}/`)) return rest.slice(bucket.length + 1);
  // No known bucket: keep everything after the first '/' as the key.
  const slash = rest.indexOf('/');
  return slash >= 0 ? rest.slice(slash + 1) : rest;
}

// ---------------------------------------------------------------------------
// Bedrock → Strands (loading history)
// ---------------------------------------------------------------------------

/** Convert one Bedrock ContentBlock to a Strands ContentBlockData, or null to drop. */
export function bedrockBlockToStrands(block: BedrockContentBlock, ctx?: ConverterS3Context): ContentBlockData | null {
  if ('text' in block && typeof block.text === 'string') {
    return { text: block.text };
  }
  if ('toolUse' in block && block.toolUse) {
    const tu = block.toolUse;
    return {
      toolUse: {
        name: tu.name ?? '',
        toolUseId: tu.toolUseId ?? '',
        input: (tu.input ?? {}) as ContentBlockData extends never ? never : any, // JSONValue
      },
    } as ContentBlockData;
  }
  if ('toolResult' in block && block.toolResult) {
    const tr = block.toolResult;
    const content = (tr.content ?? [])
      .map((c) => toolResultContentToStrands(c, ctx))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return {
      toolResult: {
        toolUseId: tr.toolUseId ?? '',
        // Bedrock status is optional and only ever 'error' in remote-swe; Strands
        // requires 'success' | 'error'. Absent status → success.
        status: tr.status === 'error' ? 'error' : 'success',
        content,
      },
    } as ContentBlockData;
  }
  if ('reasoningContent' in block && block.reasoningContent) {
    const rc = block.reasoningContent;
    // Redacted reasoning is a distinct union member ({ redactedContent: Uint8Array }),
    // mutually exclusive with reasoningText. Map it through so signature continuity
    // survives resume of a turn that contains redacted thinking.
    const redacted = (rc as { redactedContent?: Uint8Array }).redactedContent;
    if (redacted != null) {
      return { reasoning: { redactedContent: redacted } } as ContentBlockData;
    }
    const text = rc.reasoningText?.text;
    const signature = rc.reasoningText?.signature;
    return {
      reasoning: {
        ...(typeof text === 'string' ? { text } : {}),
        ...(typeof signature === 'string' ? { signature } : {}),
      },
    } as ContentBlockData;
  }
  if ('image' in block && block.image) {
    const img = block.image;
    const format = (img.format ?? 'png') as ImgFormat;
    const source = img.source ?? {};
    if ('bytes' in source && source.bytes) {
      return { image: { format, source: { bytes: source.bytes as Uint8Array } } } as ContentBlockData;
    }
    const s3Key = (source as { s3Key?: string }).s3Key;
    if (typeof s3Key === 'string') {
      return {
        image: { format, source: { location: { type: 's3', uri: s3KeyToUri(s3Key, ctx) } } },
      } as ContentBlockData;
    }
    return null;
  }
  // --- Video block (native support, no opaque passthrough needed) ---
  if ('video' in block && block.video) {
    const v = block.video;
    const format = v.format ?? 'mp4';
    const source = v.source as Record<string, unknown> | undefined;
    if (source && 'bytes' in source && source.bytes) {
      return { video: { format, source: { bytes: source.bytes as Uint8Array } } } as ContentBlockData;
    }
    if (source && 's3Location' in source) {
      const s3Loc = source.s3Location as { uri?: string; bucketOwner?: string } | undefined;
      if (s3Loc?.uri) {
        return {
          video: {
            format,
            source: {
              location: {
                type: 's3' as const,
                uri: s3Loc.uri,
                ...(s3Loc.bucketOwner ? { bucketOwner: s3Loc.bucketOwner } : {}),
              },
            },
          },
        } as ContentBlockData;
      }
    }
    return null;
  }
  // --- Document block (native support) ---
  if ('document' in block && block.document) {
    const d = block.document;
    const format = d.format ?? 'txt';
    const name = d.name ?? 'document';
    const source = d.source as Record<string, unknown> | undefined;
    const strandsDoc: Record<string, unknown> = { name, format };
    if (source && 'bytes' in source && source.bytes) {
      strandsDoc.source = { bytes: source.bytes as Uint8Array };
    } else if (source && 's3Location' in source) {
      const s3Loc = source.s3Location as { uri?: string; bucketOwner?: string } | undefined;
      if (s3Loc?.uri)
        strandsDoc.source = {
          location: { type: 's3', uri: s3Loc.uri, ...(s3Loc.bucketOwner ? { bucketOwner: s3Loc.bucketOwner } : {}) },
        };
      else return null;
    } else if (source && 'text' in source && typeof source.text === 'string') {
      strandsDoc.source = { text: source.text };
    } else {
      return null;
    }
    if (d.context) strandsDoc.context = d.context;
    if (d.citations) strandsDoc.citations = d.citations;
    return { document: strandsDoc } as unknown as ContentBlockData;
  }
  // --- GuardContent block (native support) ---
  if ('guardContent' in block && block.guardContent) {
    const gc = block.guardContent;
    const guardData: Record<string, unknown> = {};
    if ('text' in gc && gc.text) {
      guardData.text = { text: gc.text.text ?? '', ...(gc.text.qualifiers ? { qualifiers: gc.text.qualifiers } : {}) };
    }
    if ('image' in gc && gc.image) {
      const imgSrc = gc.image.source;
      guardData.image = {
        format: gc.image.format ?? 'png',
        source: imgSrc && 'bytes' in imgSrc ? { bytes: imgSrc.bytes as Uint8Array } : {},
      };
    }
    return { guardContent: guardData } as unknown as ContentBlockData;
  }
  // --- Citations block (native support) ---
  if ('citationsContent' in block && block.citationsContent) {
    const cc = block.citationsContent as { content?: unknown[]; citations?: unknown[] };
    return { citations: { citations: cc.citations ?? [], content: cc.content ?? [] } } as unknown as ContentBlockData;
  }
  // Truly unknown/unsupported blocks (e.g. audio, searchResult, toolAddition,
  // toolRemoval) are dropped — the SDK will throw on unknown types, and silent
  // drop is safer than turn crash.
  const blockKeys = Object.keys(block).filter((k) => k !== '$unknown');
  console.warn(`[message-converter] dropping unknown Bedrock block (keys: ${blockKeys.join(',')})`);
  return null;
}

function toolResultContentToStrands(c: unknown, ctx?: ConverterS3Context): ContentBlockData | null {
  if (!c || typeof c !== 'object') return null;
  const block = c as BedrockContentBlock;
  if ('text' in block && typeof block.text === 'string') return { text: block.text };
  // Bedrock's json member is typed `{} | null`; Strands JsonBlockData wants
  // JSONValue. The runtime shape `{ json: value }` is valid for both; the cast
  // bridges the nominal type gap (null is a valid JSONValue).
  if ('json' in block && block.json !== undefined) return { json: block.json } as unknown as ContentBlockData;
  if ('image' in block && block.image) {
    return bedrockBlockToStrands(block, ctx);
  }
  if ('video' in block && block.video) {
    return bedrockBlockToStrands(block, ctx);
  }
  if ('document' in block && block.document) {
    return bedrockBlockToStrands(block, ctx);
  }
  return null;
}

/** Convert a Bedrock Message to Strands MessageData. */
export function bedrockToStrandsMessage(msg: BedrockMessage, ctx?: ConverterS3Context): MessageData {
  const role: Role = msg.role === 'assistant' ? 'assistant' : 'user';
  const content = (msg.content ?? [])
    .map((b) => bedrockBlockToStrands(b, ctx))
    .filter((b): b is ContentBlockData => b !== null);
  return { role, content };
}

// ---------------------------------------------------------------------------
// Strands → Bedrock (persisting)
// ---------------------------------------------------------------------------

/** Convert one Strands ContentBlockData to a Bedrock ContentBlock, or null to drop. */
export function strandsBlockToBedrock(block: ContentBlockData, ctx?: ConverterS3Context): BedrockContentBlock | null {
  if ('text' in block && typeof block.text === 'string') {
    return { text: block.text };
  }
  if ('toolUse' in block && block.toolUse) {
    const tu = block.toolUse;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { toolUse: { toolUseId: tu.toolUseId, name: tu.name, input: tu.input as any } };
  }
  if ('toolResult' in block && block.toolResult) {
    const tr = block.toolResult;
    const content = (tr.content ?? [])
      .map((c) => strandsToolResultContentToBedrock(c as ContentBlockData, ctx))
      .filter((c): c is BedrockToolResultContentBlock => c !== null);
    return {
      toolResult: {
        toolUseId: tr.toolUseId,
        content,
        // Only surface an explicit 'error' status; remote-swe leaves success implicit.
        ...(tr.status === 'error' ? { status: 'error' as const } : {}),
      },
    };
  }
  if ('reasoning' in block && block.reasoning) {
    const r = block.reasoning as { text?: string; signature?: string; redactedContent?: Uint8Array | string };
    // Redacted reasoning: emit the Bedrock { redactedContent } union member. After
    // SDK toJSON the bytes are a base64 string (same as image/video/document), so
    // decode back to Uint8Array before handing it to Bedrock.
    if (r.redactedContent != null && r.redactedContent !== '') {
      const raw = r.redactedContent;
      const redactedContent = typeof raw === 'string' ? Buffer.from(raw, 'base64') : raw;
      return { reasoningContent: { redactedContent } } as unknown as BedrockContentBlock;
    }
    return {
      reasoningContent: {
        reasoningText: {
          text: r.text ?? '',
          ...(typeof r.signature === 'string' ? { signature: r.signature } : {}),
        },
      },
    };
  }
  if ('image' in block && block.image) {
    const img = block.image as { format?: string; source?: Record<string, unknown> };
    const format = (img.format ?? 'png') as ImgFormat;
    const source = img.source ?? {};
    if ('bytes' in source && source.bytes) {
      const raw = source.bytes;
      const bytes = typeof raw === 'string' ? Buffer.from(raw, 'base64') : (raw as Uint8Array);
      return { image: { format, source: { bytes } } };
    }
    const location = (source as { location?: { uri?: string } }).location;
    if (location?.uri) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { image: { format, source: { s3Key: s3UriToKey(location.uri, ctx) } as any } };
    }
    return null;
  }
  // --- Video block (native support) ---
  if ('video' in block && block.video) {
    const v = block.video as { format?: string; source?: Record<string, unknown> };
    const format = v.format ?? 'mp4';
    const source = v.source ?? {};
    if ('bytes' in source && source.bytes) {
      const raw = source.bytes;
      const bytes = typeof raw === 'string' ? Buffer.from(raw, 'base64') : (raw as Uint8Array);
      return { video: { format, source: { bytes } } } as unknown as BedrockContentBlock;
    }
    const location = (source as { location?: { type?: string; uri?: string; bucketOwner?: string } }).location;
    if (location?.uri) {
      return {
        video: {
          format,
          source: {
            s3Location: { uri: location.uri, ...(location.bucketOwner ? { bucketOwner: location.bucketOwner } : {}) },
          },
        },
      } as unknown as BedrockContentBlock;
    }
    return null;
  }
  // --- Document block (native support) ---
  if ('document' in block && block.document) {
    const d = block.document as unknown as Record<string, unknown>;
    const format = d.format as string | undefined;
    const name = d.name as string | undefined;
    const source = d.source as Record<string, unknown> | undefined;
    if (!source) return null;
    let bedrockSource: Record<string, unknown>;
    if ('bytes' in source && source.bytes) {
      const raw = source.bytes;
      bedrockSource = { bytes: typeof raw === 'string' ? Buffer.from(raw, 'base64') : raw };
    } else if ('location' in source) {
      const loc = source.location as { uri?: string; bucketOwner?: string } | undefined;
      bedrockSource = loc?.uri
        ? { s3Location: { uri: loc.uri, ...(loc.bucketOwner ? { bucketOwner: loc.bucketOwner } : {}) } }
        : {};
    } else if ('text' in source && typeof source.text === 'string') {
      bedrockSource = { text: source.text };
    } else {
      return null;
    }
    return {
      document: {
        format: format ?? 'txt',
        name: name ?? 'document',
        source: bedrockSource,
        ...(d.context ? { context: d.context } : {}),
        ...(d.citations ? { citations: d.citations } : {}),
      },
    } as unknown as BedrockContentBlock;
  }
  // --- GuardContent block (native support) ---
  if ('guardContent' in block && block.guardContent) {
    const gc = block.guardContent as Record<string, unknown>;
    const bedrockGc: Record<string, unknown> = {};
    if (gc.text && typeof gc.text === 'object') {
      const t = gc.text as { text?: string; qualifiers?: string[] };
      bedrockGc.text = { text: t.text ?? '', ...(t.qualifiers ? { qualifiers: t.qualifiers } : {}) };
    }
    if (gc.image && typeof gc.image === 'object') {
      const img = gc.image as { format?: string; source?: { bytes?: Uint8Array } };
      bedrockGc.image = { format: img.format ?? 'png', source: img.source ?? {} };
    }
    return { guardContent: bedrockGc } as unknown as BedrockContentBlock;
  }
  // --- Citations block (native support) ---
  if ('citations' in block && block.citations) {
    const c = block.citations as { citations?: unknown[]; content?: unknown[] };
    return {
      citationsContent: { citations: c.citations ?? [], content: c.content ?? [] },
    } as unknown as BedrockContentBlock;
  }
  // Drop cachePoint (never persisted) and anything else truly unknown.
  if (!('cachePoint' in block)) {
    const blockKeys = Object.keys(block).filter((k) => k !== '$unknown');
    console.warn(`[message-converter] dropping unknown Strands block (keys: ${blockKeys.join(',')})`);
  }
  return null;
}

function strandsToolResultContentToBedrock(
  c: ContentBlockData,
  ctx?: ConverterS3Context
): BedrockToolResultContentBlock | null {
  if ('text' in c && typeof c.text === 'string') return { text: c.text };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ('json' in c && (c as any).json !== undefined) return { json: (c as any).json };
  if ('image' in c && (c as { image?: unknown }).image) {
    const full = strandsBlockToBedrock(c, ctx);
    // strandsBlockToBedrock returns an { image } ContentBlock; ToolResultContentBlock
    // also has an ImageMember with the same `image` shape, so it is assignable.
    if (full && 'image' in full && full.image) return { image: full.image };
  }
  if ('video' in c && (c as { video?: unknown }).video) {
    const full = strandsBlockToBedrock(c, ctx);
    if (full && 'video' in full && full.video) return { video: full.video } as BedrockToolResultContentBlock;
  }
  if ('document' in c && (c as { document?: unknown }).document) {
    const full = strandsBlockToBedrock(c, ctx);
    if (full && 'document' in full && full.document)
      return { document: full.document } as unknown as BedrockToolResultContentBlock;
  }
  return null;
}

/** Convert a Strands MessageData to a Bedrock Message. */
export function strandsToBedrockMessage(msg: MessageData, ctx?: ConverterS3Context): BedrockMessage {
  const role = msg.role === 'assistant' ? 'assistant' : 'user';
  const content = (msg.content ?? [])
    .map((b) => strandsBlockToBedrock(b, ctx))
    .filter((b): b is BedrockContentBlock => b !== null);
  return { role, content };
}
