/**
 * toStrandsTool — adapt a remote-swe `ToolDefinition` to a Strands `tool()`
 * =========================================================================
 * remote-swe tools are `ToolDefinition<Input>`:
 *  { name, schema: ZodType<Input>, toolSpec(): Promise<Tool['toolSpec']>,
 *  handler(input, { workerId, toolUseId, globalPreferences, cancellationToken? })
 *  => Promise<string | ToolResultContentBlock[]> }
 *
 * Strands wants `tool({ name, description, inputSchema, callback })` where
 * `callback(input, ctx?: ToolContext)` returns the tool result. The remote-swe
 * handler needs per-turn deps (`workerId`, `globalPreferences`,
 * `cancellationToken`) that are NOT on the Strands ToolContext, so they are
 * injected via closure (`deps`); `toolUseId` is taken from the Strands
 * `ctx.toolUse.toolUseId`.
 *
 * NOTE (PR3 gap): a handler returning `ToolResultContentBlock[]` (e.g. image
 * results) is flattened to its text parts here; non-text blocks (image/json)
 * are summarised. Faithful multimodal tool-result passthrough is deferred —
 * the Strands tool return type is a scalar/JSON value, whereas remote-swe's
 * Bedrock path threads ToolResultContentBlock[] straight into the toolResult.
 * Tracked in the RemoteSweBedrockModel gap list.
 *
 * Wired into the live Bedrock path via `bedrockStrandsAgentLoop`.
 */
import type { ToolResultContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { tool, type ToolContext } from '@strands-agents/sdk';
import type { z, ZodType } from 'zod';
import { renderToolResult } from '@remote-swe-agents/agent-core/lib';
import { reportProgressTool, sendToAgentTool, acknowledgeAgentTool } from '@remote-swe-agents/agent-core/tools';

/** Sanitize tool names: Strands ToolRegistry requires ^[a-zA-Z0-9_-]+$ */
export const sanitizeToolName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Tool names (sanitized) that reset the forceReport timer — derived from actual tool objects. */
export const REPORT_TIMER_RESET_TOOLS = new Set(
  [reportProgressTool, sendToAgentTool, acknowledgeAgentTool].map((t) => sanitizeToolName(t.name))
);

/** Check if a tool execution should reset the forceReport timer. */
export const shouldResetReportTimer = (sanitizedName: string): boolean => REPORT_TIMER_RESET_TOOLS.has(sanitizedName);

/** Per-turn dependencies the remote-swe handler needs, injected by closure. */
export interface ToolAdapterDeps {
  workerId: string;
  globalPreferences: unknown;
  cancellationToken?: unknown;
  /** Shared mutable state for forceReport timer. */
  forceReportState?: { lastReportedTime: number; parentSessionId?: string };
}

/** Minimal structural view of a remote-swe ToolDefinition (avoids a deep import). */
export interface RemoteSweToolLike<Input> {
  readonly name: string;
  readonly schema: ZodType<Input>;
  readonly toolSpec: () => Promise<{ description?: string } & Record<string, unknown>>;
  readonly handler: (
    input: Input,
    context: {
      workerId: string;
      toolUseId: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      globalPreferences: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cancellationToken?: any;
    }
  ) => Promise<string | ToolResultContentBlock[]>;
}

/** Flatten a handler result into the scalar string Strands tools return. */
export function flattenToolResult(result: string | ToolResultContentBlock[]): string {
  if (typeof result === 'string') return result;
  const parts: string[] = [];
  for (const block of result) {
    if ('text' in block && typeof block.text === 'string') parts.push(block.text);
    else if ('json' in block) {
      try {
        parts.push(JSON.stringify(block.json));
      } catch {
        parts.push('[unserialisable json tool result]');
      }
    } else if ('image' in block) {
      parts.push('[image tool result]');
    } else {
      parts.push('[non-text tool result]');
    }
  }
  return parts.join('\n');
}

/**
 * Convert Bedrock ToolResultContentBlock[] to SDK-native content data.
 * FunctionTool._wrapInToolResult recognizes content block arrays and passes
 * them through directly into ToolResultBlock.content.
 */
export function bedrockToolResultToSdkContent(blocks: ToolResultContentBlock[]): unknown[] {
  return blocks.map((block) => {
    if ('text' in block && typeof block.text === 'string') return { text: block.text };
    if ('json' in block) return { json: block.json };
    if ('image' in block && block.image) {
      const img = block.image;
      const source = img.source ?? {};
      if ('bytes' in source && source.bytes) {
        return { image: { format: img.format ?? 'png', source: { bytes: source.bytes } } };
      }
      if ('s3Key' in source || 's3Location' in source) {
        const s3Loc = (source as { s3Location?: { uri?: string; bucketOwner?: string } }).s3Location;
        if (s3Loc?.uri) {
          return {
            image: {
              format: img.format ?? 'png',
              source: {
                location: {
                  type: 's3',
                  uri: s3Loc.uri,
                  ...(s3Loc.bucketOwner ? { bucketOwner: s3Loc.bucketOwner } : {}),
                },
              },
            },
          };
        }
      }
    }
    if ('document' in block && block.document) {
      const doc = block.document;
      const source = doc.source ?? {};
      if ('bytes' in source && source.bytes) {
        return {
          document: { format: doc.format ?? 'pdf', name: doc.name ?? 'document', source: { bytes: source.bytes } },
        };
      }
      if ('text' in source && typeof source.text === 'string') {
        return {
          document: { format: doc.format ?? 'txt', name: doc.name ?? 'document', source: { text: source.text } },
        };
      }
      if ('s3Location' in source) {
        const s3Loc = (source as { s3Location?: { uri?: string; bucketOwner?: string } }).s3Location;
        if (s3Loc?.uri) {
          return {
            document: {
              format: doc.format ?? 'pdf',
              name: doc.name ?? 'document',
              source: {
                location: {
                  type: 's3',
                  uri: s3Loc.uri,
                  ...(s3Loc.bucketOwner ? { bucketOwner: s3Loc.bucketOwner } : {}),
                },
              },
            },
          };
        }
      }
    }
    if ('video' in block && block.video) {
      const vid = block.video;
      const source = vid.source ?? {};
      if ('bytes' in source && source.bytes) {
        return { video: { format: vid.format ?? 'mp4', source: { bytes: source.bytes } } };
      }
      if ('s3Location' in source) {
        const s3Loc = (source as { s3Location?: { uri?: string; bucketOwner?: string } }).s3Location;
        if (s3Loc?.uri) {
          return {
            video: {
              format: vid.format ?? 'mp4',
              source: {
                location: {
                  type: 's3',
                  uri: s3Loc.uri,
                  ...(s3Loc.bucketOwner ? { bucketOwner: s3Loc.bucketOwner } : {}),
                },
              },
            },
          };
        }
      }
    }
    return { text: '[non-text tool result]' };
  });
}

/**
 * Convert MCP tool content array to SDK-native content blocks.
 * Exported for testability (Critical path).
 */
export function mcpContentToSdkBlocks(
  content: { type?: string; text?: string; mimeType?: string; data?: string }[],
  normalizeImageFormat: (mimeType: string | undefined) => string
): any[] {
  const blocks: unknown[] = [];
  for (const c of content) {
    if (c.type === 'text') {
      blocks.push({ text: c.text ?? '' });
    } else if (c.type === 'image' && c.data) {
      blocks.push({
        image: {
          format: normalizeImageFormat(c.mimeType),
          source: { bytes: Buffer.from(c.data, 'base64') },
        },
      });
    } else {
      blocks.push({ text: `[unsupported MCP content type: ${c.type ?? 'unknown'}]` });
    }
  }
  return blocks;
}

/**
 * Adapt a remote-swe tool to a Strands tool. `description` is resolved from the
 * remote-swe `toolSpec()` at adapt time (async), so this returns a Promise.
 */
export async function toStrandsTool<Input>(def: RemoteSweToolLike<Input>, deps: ToolAdapterDeps) {
  const spec = await def.toolSpec();
  const sanitizedName = sanitizeToolName(def.name);
  return tool({
    name: sanitizedName,
    description: spec.description ?? def.name,
    inputSchema: def.schema as unknown as z.ZodType,
    callback: async (input: unknown, ctx?: ToolContext) => {
      const toolUseId = ctx?.toolUse?.toolUseId ?? '';
      const result = await def.handler(input as Input, {
        workerId: deps.workerId,
        toolUseId,
        globalPreferences: deps.globalPreferences,
        cancellationToken: deps.cancellationToken,
      });

      // forceReport timer — reset on communication tools
      const frs = deps.forceReportState;
      if (frs && shouldResetReportTimer(sanitizedName)) {
        frs.lastReportedTime = Date.now();
      }

      // ToolResultContentBlock[] → return as SDK-native content array.
      // FunctionTool._wrapInToolResult passes content block arrays through natively,
      // so image/video/document blocks flow into SDK message → AfterToolsEvent →
      // converter → persist → items input without any side-channel.
      if (typeof result !== 'string') {
        return bedrockToolResultToSdkContent(result);
      }

      const forceReport = frs ? Date.now() - frs.lastReportedTime > 300_000 : false;
      return renderToolResult({
        toolResult: result,
        forceReport,
        parentSessionId: frs?.parentSessionId,
      });
    },
  });
}
