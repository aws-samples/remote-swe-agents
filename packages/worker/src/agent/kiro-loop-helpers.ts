import {
  getConversationHistory,
  materializeFileBlock,
  materializeImageBlock,
  ensureImageWithinBounds,
  CANONICAL_KIRO_FAILURE_MESSAGE,
  isKnownKiroInternalError,
  toUserFacingTurnError,
  isPromptTimeoutOrIdleError as isPromptTimeoutOrIdleErrorShared,
  PROMPT_SETTLE_WEDGED_ERROR,
} from '@remote-swe-agents/agent-core/lib';
import { writeBytesToKey } from '@remote-swe-agents/agent-core/aws';
import type { TurnResult, KiroAcpPromptContentBlock } from '@remote-swe-agents/agent-core/lib';
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';
import {
  USER_INPUT_MESSAGE_TYPES,
  RETRIGGER_GIVEUP_MESSAGE_TYPE,
  INTERNAL_ERROR_MESSAGE_TYPE,
} from '@remote-swe-agents/agent-core/schema';
import { Message } from '@aws-sdk/client-bedrock-runtime';
import { execFileSync } from 'child_process';
import { readFileSync, rmSync, existsSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { kiroV3SessionDir, SESSION_ID_PATTERN } from './kiro-session-synth';

const SYSTEM_PROMPT_OPEN = '<|SYSTEM_PROMPT|>';
const SYSTEM_PROMPT_CLOSE = '<|/SYSTEM_PROMPT|>';

export const NON_EMPTY_DISCARD_WARNING =
  '\n<system>WARNING: Your previous response included text blocks alongside tool calls. These text blocks were NOT delivered to the user. If the text was intended for the user, you must resend it using the Send Message To User tool.</system>';

/**
 * Legacy history-replay delimiters retained ONLY as a leak-detection
 * signature.
 *
 * Up to commit `fix/kiro-template-leak-root-fix` the worker re-injected
 * the entire DDB conversation history into kiro-cli's system prompt as
 * text wrapped in these tokens (one tag for each role / content kind).
 * After enough turns of replay the model latched onto the format and
 * began emitting the literal tokens as plain output — those leaked
 * straight through to DynamoDB and Slack because kiro-cli streams
 * `agent_message_chunk` text verbatim. Today the worker materialises a
 * native kiro-cli session file via {@link synthesizeKiroSessionFiles}
 * and calls `session/load`, so this format is never written to the
 * prompt anymore. We keep the literal tag list here so
 * {@link stripLeakedTemplateTokens} can scrub any pre-existing model
 * output (or a future regression) that contains them.
 */
const LEAK_TEMPLATE_TAGS = [
  '<|CONVERSATION_HISTORY|>',
  '<|/CONVERSATION_HISTORY|>',
  '<|USER|>',
  '<|/USER|>',
  '<|ASSISTANT|>',
  '<|/ASSISTANT|>',
  '<|TOOL_USE|>',
  '<|/TOOL_USE|>',
  '<|TOOL_RESULT|>',
  '<|/TOOL_RESULT|>',
  '<|ATTACHMENT|>',
  '<|/ATTACHMENT|>',
] as const;

/**
 * Strip any occurrence of the system-prompt delimiter tags from untrusted
 * text so it cannot break out of (or inject into) the SYSTEM_PROMPT block
 * we send to kiro-cli. Both the opening and closing tags are removed; their
 * placement in the final prompt is controlled exclusively by this module.
 *
 * Exported for unit testing.
 */
export const sanitizeForSystemBlock = (text: string): string => {
  return text.replaceAll(SYSTEM_PROMPT_OPEN, '').replaceAll(SYSTEM_PROMPT_CLOSE, '');
};

/**
 * Strip `<think>...</think>` (and, defensively, `<thinking>...</thinking>`)
 * blocks from the assistant's end-of-turn text so they are not surfaced to
 * the user. Some Kiro backend models (e.g. reasoning-capable OSS models)
 * emit a literal `<think>` monologue inside the text content instead of
 * routing it through a separate reasoning channel, and kiro-cli forwards
 * that text verbatim. The Bedrock backend applies the equivalent strip on
 * `<thinking>` in `packages/worker/src/agent/index.ts`; this helper keeps
 * the two backends aligned.
 *
 * Only the outer tags and their inner content are removed — surrounding
 * user-visible prose is preserved. Multi-line bodies are supported and
 * multiple blocks in the same string are all removed.
 *
 * Exported for unit testing.
 */
export const stripThinkBlocks = (text: string): string => {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
};

/**
 * Defensive scrub for kiro-cli template-delimiter leakage.
 *
 * Until the worker switched to native session synthesis, history was
 * replayed inside the system block as text wrapped in
 * `<|TOOL_USE|>...<|/TOOL_USE|>`, `<|USER|>...<|/USER|>` etc. Sessions
 * with enough turns conditioned the model into emitting the delimiters
 * verbatim as `agent_message_chunk` text — the leak that made user-
 * facing replies look like raw chat-template dumps. The synthesis path
 * makes new occurrences impossible in principle, but two cases still
 * warrant a runtime guard:
 *
 *   1. Existing DDB sessions captured a polluted assistant message
 *      before the fix shipped. When that history is re-rendered to the
 *      model on subsequent turns, the model may reuse the same shape it
 *      saw. Stripping the markers from the assistant's *current-turn*
 *      output ensures the leak never reaches Slack / DynamoDB again.
 *
 *   2. A future regression that re-introduces text replay (or any other
 *      flow that hands the model these tags as exemplars) is contained
 *      to the offending string instead of escaping into the user-visible
 *      response.
 *
 * The strip is intentionally conservative: it removes the literal tag
 * sequences only, leaving any surrounding text untouched. If a tag
 * pair encloses a body (e.g. `<|TOOL_USE|>id: x...<|/TOOL_USE|>`), the
 * body is stripped along with the tags so the resulting text reads as
 * if the leak block had not been emitted.
 *
 * Detection (without removal) is exposed via {@link containsLeakedTemplateTokens}
 * so callers can log occurrences without changing the message body when
 * that's preferable.
 *
 * Exported for unit testing.
 */
export const containsLeakedTemplateTokens = (text: string): boolean => {
  for (const tag of LEAK_TEMPLATE_TAGS) {
    if (text.includes(tag)) return true;
  }
  return false;
};

/**
 * Remove leaked kiro-cli template delimiter tags (and any payload
 * captured between matched open/close pairs) from `text`. See
 * {@link containsLeakedTemplateTokens} for the rationale.
 *
 * Strategy:
 *   1. Strip well-formed open/close pairs greedily but non-recursively.
 *      We use the smallest-match (`?` quantifier) so adjacent blocks
 *      don't get merged into one giant span.
 *   2. Strip any unpaired tags that survive step 1 — a stray opening
 *      `<|TOOL_USE|>` without a matching close should still be wiped
 *      so the user never sees the literal token.
 *   3. Collapse any double whitespace introduced by the removals so the
 *      remaining text reads naturally.
 *
 * Exported for unit testing.
 */
export const stripLeakedTemplateTokens = (text: string): string => {
  let out = text;
  // 1. Paired tags. The pairs we know about are open + matching close
  //    spelled as `<|X|>` / `<|/X|>`. Build the pair list off the
  //    LEAK_TEMPLATE_TAGS array so future additions to the upstream
  //    delimiter set only need to update one place.
  const pairs: Array<[string, string]> = [];
  for (const tag of LEAK_TEMPLATE_TAGS) {
    if (tag.startsWith('<|/')) continue; // only iterate over openers
    const close = tag.replace('<|', '<|/');
    if ((LEAK_TEMPLATE_TAGS as readonly string[]).includes(close)) {
      pairs.push([tag, close]);
    }
  }
  for (const [open, close] of pairs) {
    const escapedOpen = open.replace(/[|/]/g, (m) => `\\${m}`);
    const escapedClose = close.replace(/[|/]/g, (m) => `\\${m}`);
    const re = new RegExp(`${escapedOpen}[\\s\\S]*?${escapedClose}`, 'g');
    out = out.replace(re, '');
  }
  // 2. Remaining unpaired tags.
  for (const tag of LEAK_TEMPLATE_TAGS) {
    out = out.split(tag).join('');
  }
  // 3. Collapse any 3+ consecutive blank lines that the removals may
  //    have produced. Two blank lines is the most we keep so paragraphs
  //    remain visually separated.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
};

/**
 * Maximum character length of a tool result persisted to DynamoDB.
 *
 * DynamoDB items are hard-capped at 400 KB including the PK/SK + JSON envelope.
 * Kiro-cli's native tools (`read`, `glob`, `shell`) return outputs directly
 * from the OS with no size ceiling, so a single `fs_read` on a large file
 * would blow through the limit and fail `persistToolResultMessage`. The
 * Bedrock backend applies tool-level truncation (e.g. `executeCommand`
 * truncates stdout to 40 KB in packages/agent-core/src/tools/command-execution)
 * but kiro-cli's tools bypass our TS code entirely, so the cap must live
 * here as a last line of defence before DDB.
 *
 * 80_000 chars ≈ 80 KB with ASCII, well inside the 400 KB limit with plenty
 * of headroom for item metadata, UTF-8 multi-byte content, and the
 * surrounding `toolResult` JSON envelope.
 */
const TOOL_OUTPUT_TRUNCATE_LIMIT = 80_000;

/**
 * Truncate an over-long tool output using a head/tail strategy so the
 * model sees the beginning (usually the most informative part) and the
 * end (where errors / summaries typically appear) with a clear marker
 * in the middle.
 *
 * Matches the shape of the Bedrock-side `truncate()` helper in
 * packages/agent-core/src/private/common/lib.ts for consistency across
 * backends, but is reimplemented here because that helper is not part of
 * the published `agent-core/lib` barrel.
 *
 * Exported for unit testing.
 */
export const truncateToolOutput = (text: string, maxLength = TOOL_OUTPUT_TRUNCATE_LIMIT): string => {
  if (text.length <= maxLength) return text;
  const headRatio = 0.2;
  const headLen = Math.floor(maxLength * headRatio);
  const tailLen = maxLength - headLen;
  return (
    text.slice(0, headLen) +
    '\n..(truncated)..\n' +
    text.slice(-tailLen) +
    `\n// Output was truncated. Original length: ${text.length} characters.`
  );
};

/**
 * Resolve the toolResult body string that gets persisted + emitted for a
 * kiro tool_call_update, applying truncation and the never-empty guard.
 *
 * The extracted output (from the kiro dialect decoder / `event.output`) can be:
 *   - `undefined` when kiro-cli emitted no rawOutput at all (notably
 *     `status: failed`, and older builds),
 *   - `""` for a successful no-output tool (MCP void / no-output bash),
 *   - a long string that must be capped before a DDB put.
 *
 * A toolResult is NEVER persisted as an empty string (the replay / synthesis
 * paths are fragile on empty bodies), so we always surface something: the real
 * output, a truncation marker, or an explicit placeholder line.
 *
 * Shared by BOTH the legacy `kiroAgentLoop` and the ACP-SDK
 * `kiroAcpSdkAgentLoop` so the two paths cannot drift (mechanised drift
 * guard). Exported for unit testing.
 */
/**
 * Whether an ACP `tool_call_update.status` is TERMINAL (the tool has finished).
 * The ACP lifecycle is `pending → in_progress → completed | failed`; only
 * `completed`/`failed` are terminal. Non-terminal updates (v2's initial
 * `status:''`, v3's `in_progress` — v3 emits 3 updates: in_progress×2 →
 * completed) MUST be dropped before persist/emit, or a placeholder is written
 * early and the real output is lost + the toolResult event double-emits
 * (duplicate terminal status updates). Shared by BOTH the legacy loop and the ACP-SDK loop so the
 * terminal guard cannot drift. Exported for unit testing.
 */
export const isTerminalToolStatus = (status: string): boolean => status === 'completed' || status === 'failed';

export const resolveToolResultOutput = (status: string, extracted: string | undefined): string => {
  if (status === 'failed') {
    return extracted && extracted.length > 0 ? truncateToolOutput(extracted) : 'Tool failed.';
  }
  if (extracted === undefined) {
    return 'Tool executed successfully (no output reported).';
  }
  if (extracted.length === 0) {
    return 'Tool executed successfully (no content returned).';
  }
  return truncateToolOutput(extracted);
};

/**
 * Per-turn bookkeeping state for the tool-boundary text DISCARD (Bedrock
 * parity). The fields are mutated in place by
 * {@link processToolCallDiscardBoundary} and read by the end-of-turn
 * save path in `kiroAgentLoop`.
 *
 * ## Why discard (Bedrock parity)
 *
 * kiro-cli streams *every* `agent_message_chunk` between two prompts
 * (the text the model emits *before* a tool call and the text it emits
 * *after* the final tool result) into one continuous run; `result.text`
 * at the end of `prompt()` is that same concatenation. The text a model
 * emits immediately before a `tool_call` is reasoning / self-talk ("Let me
 * check the data model..."), NOT a finished user-facing reply.
 *
 * The Bedrock backend already drops this: when `stopReason == 'tool_use'`
 * the assistant message's text blocks are persisted as part of the
 * `toolUse` history item (which the webapp renderer ignores — it only
 * renders `block.toolUse`) and are NEVER delivered to the user; a
 * `<system>WARNING ... use sendMessageToUser</system>` note is appended
 * to the tool result instead. See `packages/worker/src/agent/index.ts`.
 *
 * To bring kiro-cli to the same behaviour we DISCARD the pre-tool chunk
 * run at every `tool_call` boundary: it is neither persisted nor emitted
 * to the user. Only the post-last-tool tail (the model's actual
 * end-of-turn reply, with no tool_use after it) is delivered, exactly
 * like a Bedrock turn whose final message carries no tool_use.
 *
 * Field semantics:
 *  - `bufferedRawText`:  raw `agent_message_chunk` text accumulated since
 *    the last boundary. Filled by `onChunk` (synchronously, on the
 *    JSON-RPC dispatcher tick); drained (and discarded) by every
 *    `tool_call` event. Whatever remains after the LAST tool call is the
 *    post-tool tail consumed by the end-of-turn save.
 *  - `discardedRawSoFar`:  cumulative raw chunk text that has been
 *    discarded at one or more tool boundaries. Used to subtract from
 *    `result.text` (which is also raw) at end of turn so the final save
 *    only carries the post-last-tool tail. The accumulator stores the
 *    RAW (un-stripped) form because `result.text` is itself raw; using a
 *    cleaned form would mis-align after `<think>` removal.
 *
 * Exported for unit testing.
 */
export interface ToolBoundaryFlushState {
  bufferedRawText: string;
  discardedRawSoFar: string;
}

/**
 * Synchronous tool-boundary DISCARD dispatcher (Bedrock parity).
 *
 * MUST be the FIRST thing the `tool_call` branch of `handleEvent` does,
 * before ANY await. Steps (all synchronous so there is no await window
 * in which an `onChunk` callback could bleed into the discarded prefix):
 *   1. Snapshot `state.bufferedRawText` and reset it to `''`. Any chunk
 *      delivered after this line lands in the now-empty buffer and is
 *      attributed to the next boundary (or, after the final tool, to the
 *      post-tool tail).
 *   2. Append the snapshot (RAW form) to `state.discardedRawSoFar` so the
 *      end-of-turn `result.text.startsWith(discardedRawSoFar)` subtract
 *      stays aligned. We append unconditionally — `result.text` carries
 *      every chunk regardless of whitespace / leak content, so the raw
 *      subtraction MUST account for them all or the post-prompt slice
 *      will be mis-positioned.
 *
 * The snapshot is intentionally NOT persisted to DDB nor emitted to the
 * webapp: the pre-tool text is discarded, mirroring how Bedrock drops
 * text blocks that accompany a tool_use. User-facing progress during a
 * tool turn must go through the `sendMessageToUser` MCP tool (which is a
 * `tool_call` and is rendered normally), exactly as on the Bedrock path.
 *
 * Exported for unit testing.
 */
export const processToolCallDiscardBoundary = (state: ToolBoundaryFlushState): void => {
  // Synchronous snapshot + reset. Anything appended to
  // state.bufferedRawText after this line lands in the next bucket.
  const toDiscard = state.bufferedRawText;
  state.bufferedRawText = '';
  if (toDiscard.length === 0) return;
  // Raw accumulator: append unconditionally so the end-of-turn
  // `result.text.startsWith(discardedRawSoFar)` invariant holds even when
  // the buffer was whitespace-only or fully scrubbed.
  state.discardedRawSoFar += toDiscard;
};

/**
 * Strip every legacy history-replay delimiter from `text`. Historically
 * this helper was applied to every chunk of untrusted DDB text before it
 * was wrapped in `<|USER|>` / `<|TOOL_USE|>` / etc. tags. The replay
 * pipeline has been retired (see {@link synthesizeKiroSessionFiles})
 * but the helper remains for two reasons:
 *
 *   1. The tags it strips overlap with the leak signature, so any
 *      future caller can still defensively scrub these markers from
 *      arbitrary text.
 *   2. Historical unit tests assert behaviour against this function;
 *      preserving the API avoids a needlessly large diff.
 *
 * Exported for unit testing.
 */
export const sanitizeForHistoryBlock = (text: string): string => {
  let out = sanitizeForSystemBlock(text);
  for (const tag of LEAK_TEMPLATE_TAGS) {
    out = out.replaceAll(tag, '');
  }
  return out;
};

/**
 * Messages with these `messageType` values represent real user-originated
 * input (typed by a human, delivered by a parent agent, or fired by an
 * EventBridge trigger) and are eligible for re-delivery to the Kiro ACP
 * session after a mid-flight cancellation. `toolUse` / `toolResult` items
 * are excluded because they are synthesised by the agent loop itself and
 * must not be treated as fresh user input. The actual set lives in
 * `agent-core/schema` so that the kiro-cli session synthesiser
 * (`packages/worker/src/agent/kiro-session-synth.ts`) consumes the same
 * predicate and the two history paths cannot drift apart.
 */

interface ContentBlock {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input?: unknown };
  toolResult?: {
    toolUseId?: string;
    content?: Array<ToolResultContentBlock>;
    status?: string;
  };
  image?: ImageBlock;
  file?: { fileName?: string; source?: { s3Key?: string }; size?: number; mimeType?: string };
}

/** Subset of Bedrock's `Image` block the worker currently stores on DDB. */
interface ImageBlock {
  format?: string;
  source?: { s3Key?: string; bytes?: unknown };
}

/** A Bedrock tool-result inner content block — text, image, or other. */
interface ToolResultContentBlock {
  text?: string;
  image?: ImageBlock;
}

const parseContentBlocks = (raw: string): ContentBlock[] => {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ContentBlock[];
  } catch {
    // Non-JSON content (legacy rows?) — fall back to a single text block so
    // the caller can still render it verbatim rather than dropping data.
    return [{ text: raw }];
  }
  return [];
};

const stringifyToolInput = (input: unknown): string => {
  if (input === undefined) return '';
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
};

/**
 * Map Bedrock's Image `format` (e.g. `'png'`) or an arbitrary extension to
 * the MIME string ACP expects on an `ImageContent` block. Falls back to
 * `application/octet-stream` so the block is never dropped for an unknown
 * format.
 */
export const imageFormatToMimeType = (format: string | undefined): string => {
  const f = (format ?? '').toLowerCase().trim();
  switch (f) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
};

/**
 * Intermediate segment produced while walking the DDB history. A sequence of
 * segments is later materialised into `KiroAcpPromptContentBlock[]` by
 * fetching image bytes from S3 and base64-encoding them.
 *
 * This split keeps the walk pure and synchronous (trivial to unit-test) while
 * isolating the IO-bound materialisation step (which can be mocked).
 */
type RenderSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; s3Key: string; mimeType: string }
  | { kind: 'file'; s3Key: string; fileName: string };

/**
 * Injection function for materialising a `file` block into local FS.
 * Exposed so tests can mock without touching S3 or the real local
 * filesystem. Defaults to the agent-core helper at runtime which mirrors
 * the Bedrock backend's path layout
 * (`/tmp/.remote-swe-files/${seq}_${fileName}`) and shares the same
 * memoization cache.
 */
type MaterializeFileFn = (s3Key: string, fileName?: string) => Promise<{ localPath: string; fileName: string }>;

/**
 * Injection function for materialising an `image` block into local FS
 * (both original + lightweight preview). Exposed so tests can mock
 * without touching S3 or the real local filesystem.
 */
type MaterializeImageFn = (
  s3Key: string
) => Promise<{ originalPath: string; previewPath: string; fileName: string; s3Uri: string }>;

/**
 * Mutable segment builder used while walking the history. Coalesces
 * consecutive text writes into a single text segment so the final
 * `ContentBlock[]` has no adjacent text blocks.
 */
class SegmentBuilder {
  private segments: RenderSegment[] = [];
  private textBuf = '';

  appendText(s: string): void {
    if (s.length > 0) this.textBuf += s;
  }

  emitImage(s3Key: string, mimeType: string): void {
    if (this.textBuf.length > 0) {
      this.segments.push({ kind: 'text', text: this.textBuf });
      this.textBuf = '';
    }
    this.segments.push({ kind: 'image', s3Key, mimeType });
  }

  emitFile(s3Key: string, fileName: string): void {
    if (this.textBuf.length > 0) {
      this.segments.push({ kind: 'text', text: this.textBuf });
      this.textBuf = '';
    }
    this.segments.push({ kind: 'file', s3Key, fileName });
  }

  build(): RenderSegment[] {
    if (this.textBuf.length > 0) {
      this.segments.push({ kind: 'text', text: this.textBuf });
      this.textBuf = '';
    }
    return this.segments;
  }
}

/**
 * Materialise a segment list into ACP prompt ContentBlocks. Image segments
 * are fetched from S3 and base64-encoded. If the agent does not advertise
 * `promptCapabilities.image`, image segments are degraded to inline
 * placeholder text so we never send an unsupported block.
 *
 * File segments are materialised onto the local filesystem via
 * {@link materializeFileBlock} (shared with the Bedrock backend) and the
 * canonical
 * `the file "${fileName}" is stored locally on ${localPath}` text is
 * injected so kiro-cli's native `read` / `shell` tools can open the
 * bytes the same way Bedrock-mode tools do. The kiro-cli ACP protocol
 * has no first-class `file` content kind on prompts, so this is the
 * documented escape hatch — verified empirically against kiro-cli 2.x.
 *
 * Errors fetching S3 bytes are swallowed and replaced with a placeholder
 * so one missing object doesn't poison the whole prompt (error fallback
 * for a failed S3 get).
 *
 * Exported for unit testing.
 */
export const materialisePromptSegments = async (
  segments: RenderSegment[],
  opts: {
    materializeFile?: MaterializeFileFn;
    materializeImage?: MaterializeImageFn;
  } = {}
): Promise<KiroAcpPromptContentBlock[]> => {
  const materialize = opts.materializeFile ?? materializeFileBlock;
  const materializeImage = opts.materializeImage ?? materializeImageBlock;
  const blocks: KiroAcpPromptContentBlock[] = [];
  const appendText = (text: string) => {
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text') {
      last.text += text;
    } else if (text.length > 0) {
      blocks.push({ type: 'text', text });
    }
  };

  for (const seg of segments) {
    if (seg.kind === 'text') {
      appendText(seg.text);
      continue;
    }
    if (seg.kind === 'image') {
      try {
        const { previewPath, fileName, s3Uri } = await materializeImage(seg.s3Key);
        appendText(
          `the image "${fileName}" is available as a resized preview at ${previewPath} (original: ${s3Uri})\n` +
            `to view this image, use the readLocalImage tool on the preview path`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[kiro-agent-loop] failed to materialise image ${seg.s3Key}: ${msg}`);
        appendText(`[image attachment, mimeType: ${seg.mimeType}, s3Key: ${seg.s3Key}, note: failed-to-fetch]`);
      }
      continue;
    }
    // seg.kind === 'file' — download to local FS and inject the canonical
    // "stored locally on" text so the agent can open it with native tools.
    // S3 fetch / disk write failures are swallowed and replaced with a
    // placeholder mentioning the s3Key, mirroring the image-segment fault
    // tolerance: one bad attachment must not poison the whole prompt.
    try {
      const { localPath, fileName: resolvedName } = await materialize(seg.s3Key, seg.fileName);
      appendText(`the file "${resolvedName}" is stored locally on ${localPath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[kiro-agent-loop] failed to materialise file ${seg.s3Key}: ${msg}`);
      appendText(`[file attachment, fileName: ${seg.fileName}, s3Key: ${seg.s3Key}, note: failed-to-fetch]`);
    }
  }

  return blocks;
};

/**
 * Walk the current-turn user MessageItem's parsed ContentBlock list and
 * emit text + image + file segments into the provided builder. Text is
 * sanitised with `sanitizeForSystemBlock` because the current-turn body
 * is rendered immediately after the closing SYSTEM_PROMPT tag and must
 * not be allowed to inject a forged tag boundary.
 *
 * `file` blocks are emitted as file segments so
 * {@link materialisePromptSegments} can S3-download them to local FS and
 * inject the canonical
 * `the file "${fileName}" is stored locally on ${localPath}` text. The
 * Bedrock backend already does the same (via `postProcessMessageContent`)
 * — handling them here keeps both backends symmetric and prevents user-
 * visible attachment loss on `inferenceMode=kiro-cli` sessions.
 *
 * `toolUse` / `toolResult` blocks are still dropped because a user-
 * authored turn never carries tool dispatch metadata.
 */
const renderCurrentTurnIntoBuilder = (blocks: ContentBlock[], b: SegmentBuilder): void => {
  let wroteSomething = false;
  const newlineIfNeeded = () => {
    if (wroteSomething) b.appendText('\n');
  };
  for (const block of blocks) {
    if (typeof block.text === 'string' && block.text.trim().length > 0) {
      newlineIfNeeded();
      b.appendText(sanitizeForSystemBlock(block.text));
      wroteSomething = true;
    } else if (typeof block.image?.source?.s3Key === 'string' && block.image.source.s3Key.length > 0) {
      newlineIfNeeded();
      const s3Key = block.image.source.s3Key;
      const mime = imageFormatToMimeType(block.image.format);
      b.emitImage(s3Key, mime);
      wroteSomething = true;
    } else if (typeof block.file?.source?.s3Key === 'string' && block.file.source.s3Key.length > 0) {
      newlineIfNeeded();
      const s3Key = block.file.source.s3Key;
      const fileName = block.file.fileName || s3Key.split('/').pop() || 'file';
      b.emitFile(s3Key, fileName);
      wroteSomething = true;
    }
    // Other block kinds (toolUse / toolResult) are intentionally dropped
    // for the current turn — see doc comment above.
  }
};

/**
 * Assemble the full `session/prompt` ContentBlock[] for a turn. This is the
 * single source of truth used both on the initial prompt and on the
 * subprocess-crash retry path, so the history-replay branch is evaluated
 * against the *latest* sessionOutcome and can never drift out of sync.
 *
 * `currentTurnItem` is the MessageItem representing the user's just-sent
 * turn (role === 'user'). Its ContentBlock[] is walked to emit both text
 * and image segments so attachments on the current turn reach kiro-cli —
 * the previous `userMessage: string` signature dropped image blocks at the
 * orchestrator layer (see `extractUserMessage` in orchestrator.ts).
 *
 * Prior history is NOT injected here. After this PR, conversation
 * memory survives kiro-cli subprocess restarts via native session
 * synthesis ({@link synthesizeKiroSessionFiles} + `session/load`)
 * rather than text replay — so this builder only ever emits the system
 * prompt envelope and the current turn body.
 *
 * Exported for unit testing.
 */
export const buildKiroPromptBlocks = async (params: {
  systemPrompt: string;
  currentTurnItem: MessageItem;
  materializeFile?: MaterializeFileFn;
  materializeImage?: MaterializeImageFn;
}): Promise<KiroAcpPromptContentBlock[]> => {
  const { systemPrompt, currentTurnItem } = params;
  const sanitizedSystem = sanitizeForSystemBlock(systemPrompt);
  const currentBlocks = parseContentBlocks(currentTurnItem.content);

  // Top-level framing:
  //   <|SYSTEM_PROMPT|>
  //   <systemBody>
  //   <|/SYSTEM_PROMPT|>
  //
  //   <currentTurnBody>  ← text + optional image / file segments
  //
  // The current-turn body is a sequence of segments (text + image + file);
  // we assemble them in a single SegmentBuilder and then materialise them
  // into ACP ContentBlocks (fetching image bytes / writing file bytes to
  // local FS as needed).
  const wrapper = new SegmentBuilder();
  wrapper.appendText(`${SYSTEM_PROMPT_OPEN}\n${sanitizedSystem}`);
  wrapper.appendText(`\n${SYSTEM_PROMPT_CLOSE}\n\n`);
  renderCurrentTurnIntoBuilder(currentBlocks, wrapper);

  return materialisePromptSegments(wrapper.build(), {
    materializeFile: params.materializeFile,
    materializeImage: params.materializeImage,
  });
};

/**
 * Maximum character budget for the recovery history summary injected into
 * the system prompt when session synthesis fails. Keeps the prompt within
 * safe context limits while providing enough history for continuity.
 */
const RECOVERY_HISTORY_MAX_CHARS = 50_000;

/**
 * Build a condensed conversation history summary for injection into the
 * system prompt when `ensureSessionStarted` returns
 * `'new-after-recovery-failure'`. The summary gives the model enough
 * context to continue the conversation naturally instead of acting like
 * first contact.
 *
 * Strategy: walk the history tail-first, collecting user and assistant
 * text messages until the character budget is exhausted. Tool use/result
 * pairs are summarised as one-liners to save space.
 *
 * Exported for unit testing.
 */
export const buildRecoveryHistorySummary = (history: MessageItem[]): string => {
  if (history.length === 0) return '';

  const lines: string[] = [];
  let charCount = 0;

  for (let i = history.length - 1; i >= 0 && charCount < RECOVERY_HISTORY_MAX_CHARS; i--) {
    const item = history[i]!;
    let line = '';

    if (
      item.role === 'user' &&
      (item.messageType === 'userMessage' || item.messageType === 'agentMessage' || item.messageType === 'eventTrigger')
    ) {
      const blocks = parseContentBlocks(item.content);
      const text = blocks
        .map((b) => b.text ?? '')
        .filter((t) => t.length > 0)
        .join('\n');
      if (text.length === 0) continue;
      line = `[User]: ${text}`;
    } else if (item.messageType === 'assistant') {
      const blocks = parseContentBlocks(item.content);
      const text = blocks
        .map((b) => b.text ?? '')
        .filter((t) => t.length > 0)
        .join('\n');
      if (text.length === 0) continue;
      line = `[Assistant]: ${text}`;
    } else if (item.messageType === 'toolUse') {
      const blocks = parseContentBlocks(item.content);
      const names = blocks.filter((b) => b.toolUse).map((b) => b.toolUse!.name ?? 'unknown');
      if (names.length === 0) continue;
      line = `[Tool call: ${names.join(', ')}]`;
    } else if (item.messageType === 'toolResult') {
      const blocks = parseContentBlocks(item.content);
      const snippets = blocks
        .filter((b) => b.toolResult)
        .map((b) => {
          const text =
            b
              .toolResult!.content?.map((c) => c.text ?? '')
              .join('')
              .slice(0, 200) ?? '';
          return text.length > 0 ? text : '(no output)';
        });
      if (snippets.length === 0) continue;
      line = `[Tool result: ${snippets.join('; ').slice(0, 300)}]`;
    } else {
      continue;
    }

    if (charCount + line.length > RECOVERY_HISTORY_MAX_CHARS) {
      const remaining = RECOVERY_HISTORY_MAX_CHARS - charCount;
      if (remaining > 100) {
        lines.unshift(line.slice(0, remaining) + '...(truncated)');
      }
      break;
    }
    lines.unshift(line);
    charCount += line.length + 1;
  }

  if (lines.length === 0) return '';

  return (
    '\n\n--- RECOVERED SESSION HISTORY ---\n' +
    'This session was recovered after a process restart. The following is a summary of the prior conversation. ' +
    'Continue naturally from where you left off — do NOT greet the user as if this is a new conversation.\n\n' +
    lines.join('\n') +
    '\n--- END RECOVERED HISTORY ---'
  );
};

/**
 * Compute a rough byte size for diagnostic logging — text length + base64
 * image payload length. Counts JS string length (UTF-16 code units) which is
 * a good enough approximation for log noise purposes.
 */
const promptBlocksSize = (blocks: KiroAcpPromptContentBlock[]): { text: number; image: number; imageCount: number } => {
  let text = 0;
  let image = 0;
  let imageCount = 0;
  for (const b of blocks) {
    if (b.type === 'text') text += b.text.length;
    else if (b.type === 'image') {
      image += b.data.length;
      imageCount += 1;
    }
  }
  return { text, image, imageCount };
};

/**
 * Per-step auto-retrigger backoff schedule (ms). The Nth (0-based) retry within
 * the active burst waits `RETRIGGER_BACKOFF_SCHEDULE_MS[N]`, and every retry
 * beyond the end of the array reuses the last (capped) value.
 *
 * ## Why a schedule + cap instead of unbounded exponential
 *
 * The previous rule (`30s * 2^N`, give up after 3) produced a total recovery
 * envelope of only ~3.5 min (30s+60s+120s). Real CloudWatch data over 14 days
 * (1481 `-32603` events, clustered with a 5-min idle gap into 146 multi-event
 * bursts) showed the kiro-cli backend `-32603` failure is BURSTY, not a
 * short-lived per-turn hiccup: 53% of bursts (77/146) outlast 3.5 min, p90 is
 * ~17 min, max ~74 min. So the 3.5-min envelope was structurally too short and
 * the turn gave up — leaking `CANONICAL_KIRO_FAILURE_MESSAGE` — while the
 * backend was still mid-burst.
 *
 * The schedule keeps the FIRST retry fast (30s — unchanged user-perceived
 * latency for the common case where the burst is already over) and grows to a
 * 5-min cap so a long burst is probed without spamming. The individual sleep is
 * capped at 5 min so no single in-process auto-retrigger sleep
 * (`orchestrator.ts` runs it via `setTimeout` with the kill-timer paused) is
 * dangerously long.
 */
const RETRIGGER_BACKOFF_SCHEDULE_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;

/**
 * Total wall-clock budget (ms) for transparent auto-recovery within a burst.
 * Once the elapsed time since the first retrigger of the active burst reaches
 * this, the turn stops retrying and surfaces the canonical failure ONCE.
 *
 * Calibrated from the burst-duration distribution above: ~30 min absorbs ~97%
 * (141/146) of observed bursts. The rare long tail (30–74 min) is intentionally
 * NOT chased forever — chasing it would hold the session silent for over an
 * hour, which is the "can't tell the session is dead" anti-claim. Instead the
 * budget end emits a single user-facing notice and gives up, so a genuinely
 * stuck session is always surfaced exactly once.
 */
const RETRIGGER_BUDGET_MS = 30 * 60 * 1000; // 30 min

/**
 * Build the TurnResult for a prompt failure that survived the in-turn retry.
 *
 * `backoffMs !== null`: the retrigger budget still has room, so the turn
 * schedules an auto-retry. This is NOT a termination — it must NOT set
 * `abnormalTermination`, otherwise the parent is falsely woken (and re-woken)
 * while the child is self-recovering (design A: a self-recovering turn stays
 * silent to the parent).
 *
 * It must ALSO stay silent to the USER: a self-recovering turn is an internal
 * hiccup, so we set `previewText: ''` + `skipFinalize: true` so `finalizeTurn`
 * delivers nothing to Slack / the webapp / the parent. (Previously the raw
 * `[System] Prompt failed after retry: ...kiro-cli wedged...` string was put
 * in `previewText`, which `shouldSuppressFinalize` did NOT recognise as a
 * placeholder, so it leaked verbatim.) The
 * error is still persisted by the caller as an internal-only message type and
 * logged to CloudWatch for observability.
 *
 * `backoffMs === null`: the budget is exhausted and the child gave up — a real
 * termination that must wake the parent via `abnormalTermination`. The reason
 * is passed verbatim (it is sanitised to {@link CANONICAL_KIRO_FAILURE_MESSAGE}
 * at the UX boundary by `notifyTermination` callers / `toUserFacingTurnError`),
 * and the user-facing `previewText` is the canonical phrase rather than the
 * raw kiro-cli error.
 *
 * Exported as the single source of truth for both returns so the parent
 * over-wake regression can be pinned in a unit test.
 */
export const buildPromptFailureResult = (
  errorMessage: Message,
  errorFeedback: string,
  backoffMs: number | null
): TurnResult => {
  if (backoffMs !== null) {
    // Transparent self-recovery: deliver nothing to the UX. The error record
    // is still persisted (internal-only messageType) + logged by the caller.
    return {
      assistantMessage: errorMessage,
      alreadyPersisted: true,
      previewText: '',
      skipFinalize: true,
      retrigger: true,
      retriggerDelayMs: backoffMs,
    };
  }
  return {
    assistantMessage: errorMessage,
    alreadyPersisted: true,
    // UX-facing preview is the canonical phrase, never the raw kiro error.
    previewText: toUserFacingTurnError(errorFeedback),
    abnormalTermination: {
      reason: `${toUserFacingTurnError(errorFeedback)} (gave up after exhausting the ${Math.round(
        RETRIGGER_BUDGET_MS / 60_000
      )}-minute auto-recovery budget)`,
    },
  };
};

/**
 * Deps for {@link buildRetryFailureResult}. All are true externals injected so
 * the orchestration (fast-fail decision, retrigger vs give-up, bubble persist)
 * runs for real in tests while DDB / notification stay mocked.
 */
export interface RetryFailureDeps {
  workerId: string;
  unsub: () => void;
  persistErrorBubble: (workerId: string, errorText: string) => Promise<string | undefined>;
  saveConversationHistory: (workerId: string, msg: Message, tokenCount: number, tag: string) => Promise<unknown>;
  getRetriggerBurstStats: (workerId: string) => Promise<{ count: number; elapsedMs: number }>;
  computeRetriggerBackoffMs: (retriggerCount: number, elapsedMs?: number) => number | null;
}

/**
 * Shared retry-failure handler (legacy handleRetryFailure parity plus the
 * image-dimension fast-fail). Called when a retry attempt fails — the general
 * ladder retry OR the image-dimension recovery retry — so both paths share ONE
 * decision surface (no drift):
 *
 *   1. fast-fail: if the retry failure is ITSELF an image dimension
 *      error, do NOT enter the auto-retrigger burst (that was the 30-min loop
 *      incident). Surface once with abnormalTermination. fast-fail is a
 *      permanent surface → error-bubble pattern (persist + messageSK on result).
 *   2. otherwise schedule a transparent auto-retrigger within the time budget;
 *   3. or give up (also an error bubble) once the budget is exhausted.
 *
 * Exported + dependency-injected so the fast-fail regression and giveup-bubble
 * behaviours are unit-testable against real code (Test Effectiveness Rule).
 */
export const buildRetryFailureResult = async (
  deps: RetryFailureDeps,
  retryMsg: string,
  originalMsg: string
): Promise<TurnResult> => {
  if (isImageDimensionError(retryMsg)) {
    console.log(`[kiro-loop-helpers] retry failure is an image dimension error — fast-failing (no retrigger burst)`);
    const hint = getKiroPermanentErrorHint(retryMsg);
    const userNotification = `The image size constraint error persists after recovery. The session history contains a large image that was never persisted to S3, so this turn could not recover automatically. Automatic recovery will be attempted again on your next message.\n\nCause: ${hint}`;
    const errorMessage: Message = { role: 'assistant', content: [{ text: userNotification }] };
    const messageSK = await deps.persistErrorBubble(deps.workerId, userNotification);
    await deps.saveConversationHistory(deps.workerId, errorMessage, 0, INTERNAL_ERROR_MESSAGE_TYPE);
    deps.unsub();
    return {
      assistantMessage: errorMessage,
      alreadyPersisted: true,
      previewText: userNotification,
      messageSK,
      abnormalTermination: { reason: userNotification },
    };
  }

  const errorFeedback = `[System] Prompt failed after retry: ${originalMsg}`;
  const errorMessage: Message = { role: 'assistant', content: [{ text: errorFeedback }] };
  await deps.saveConversationHistory(deps.workerId, errorMessage, 0, INTERNAL_ERROR_MESSAGE_TYPE);

  const burst = await deps.getRetriggerBurstStats(deps.workerId);
  const backoffMs = deps.computeRetriggerBackoffMs(burst.count, burst.elapsedMs);
  if (backoffMs !== null) {
    console.log(
      `[kiro-loop-helpers] scheduling auto-retrigger #${burst.count + 1} after ${backoffMs}ms ` +
        `(burst elapsed ${Math.round(burst.elapsedMs / 1000)}s)`
    );
    deps.unsub();
    return buildPromptFailureResult(errorMessage, errorFeedback, backoffMs);
  }
  console.log(`[kiro-loop-helpers] auto-retrigger budget exhausted`);
  await deps.saveConversationHistory(
    deps.workerId,
    { role: 'assistant', content: [{ text: '[System] Auto-recovery budget exhausted' }] },
    0,
    RETRIGGER_GIVEUP_MESSAGE_TYPE
  );
  // Give-up is user-facing: persist the notification as an 'assistant' bubble
  // and attach its SK so finalize delivers with the same SK (error-bubble pattern).
  const userFacingText = toUserFacingTurnError(errorFeedback);
  const messageSK = await deps.persistErrorBubble(deps.workerId, userFacingText);
  const giveUpResult = buildPromptFailureResult(errorMessage, errorFeedback, null);
  giveUpResult.messageSK = messageSK;
  deps.unsub();
  return giveUpResult;
};

/**
 * Deps for {@link runImageDimensionRecovery}. dispose / invalidate / resynth /
 * startFreshAgent / runPrompt are injected so the orchestration ORDER (dispose
 * BEFORE invalidate — the SIGTERM-flush race — then resynth, then a single
 * retry) runs for real in tests while the real subprocess/fs/DDB stay faked.
 */
export interface ImageDimensionRecoveryDeps<TResult> {
  /** Authoritative in-use kiro sessionId (never cleared). */
  effectiveSessionId: string;
  cwd: string;
  /** Dispose the current (wedged) agent. MUST run before invalidate. */
  dispose: () => Promise<void>;
  /** Delete on-disk session files so the next load re-synthesises. */
  invalidate: (sessionId: string, cwd: string) => void;
  /** Re-synthesise v3 session files from DDB history under the same id. */
  resynth: (sessionId: string, cwd: string) => Promise<void>;
  /** Build a fresh agent and start()/load() it. */
  startFreshAgent: () => Promise<void>;
  /** Run the prompt once against the fresh agent; resolves the turn result. */
  runPrompt: () => Promise<TResult>;
}

export type ImageDimensionRecoveryOutcome<TResult> =
  | { kind: 'success'; result: TResult }
  | { kind: 'start-failed'; error: unknown }
  | { kind: 'retry-failed'; error: unknown };

/**
 * Same-turn image-dimension recovery orchestration (ported from the Bedrock
 * loop). Enforces the order: dispose → invalidate → resynth → fresh agent →
 * one retry prompt. kiroSessionId is preserved — the caller passes the
 * same {@link ImageDimensionRecoveryDeps.effectiveSessionId} to invalidate and
 * resynth so the re-synthesis writes to the id that load will look up.
 *
 * Returns a discriminated outcome; the caller maps 'retry-failed' to
 * {@link buildRetryFailureResult} (which fast-fails on a repeat image error)
 * and 'start-failed' to a rethrow. Exported + injected for real-code testing of
 * the dispose-before-invalidate order and the recovery-success path.
 */
export const runImageDimensionRecovery = async <TResult>(
  deps: ImageDimensionRecoveryDeps<TResult>
): Promise<ImageDimensionRecoveryOutcome<TResult>> => {
  await deps.dispose(); // dispose FIRST so kiro-cli cannot flush files back after deletion
  deps.invalidate(deps.effectiveSessionId, deps.cwd);
  try {
    await deps.resynth(deps.effectiveSessionId, deps.cwd);
  } catch (resynthErr) {
    // Non-fatal: an empty/failed re-synthesis still lets load fabricate a fresh
    // session; the retry can proceed. Logged for diagnosis, matching main.
    console.error(
      `[kiro-loop-helpers] re-synthesis during image recovery failed for ${deps.effectiveSessionId}:`,
      resynthErr instanceof Error ? resynthErr.message : resynthErr
    );
  }
  try {
    await deps.startFreshAgent();
  } catch (error) {
    return { kind: 'start-failed', error };
  }
  try {
    const result = await deps.runPrompt();
    return { kind: 'success', result };
  } catch (error) {
    return { kind: 'retry-failed', error };
  }
};

/**
 * Decide the next auto-retrigger backoff (ms) for a burst, or `null` to give
 * up. Pure + exported so the time-based budget rule is unit-testable in
 * isolation from DynamoDB.
 *
 * Time-based budget (replaces the old count-based `retriggerCount < 3`):
 *   - `retriggerCount` is how many retriggers already fired in the active
 *     burst (used only to index the backoff schedule).
 *   - `elapsedMs` is the wall-clock time since the FIRST retrigger of the
 *     active burst. Once it reaches {@link RETRIGGER_BUDGET_MS} the budget is
 *     exhausted and the function returns `null` (give up + surface once).
 *
 * ## Why elapsed time, not a retry count
 *
 * The old count-based rule had two structural bugs against the real bursty
 * `-32603` failure mode:
 *   1. 3 retries × short backoff = a ~3.5-min envelope that loses to the
 *      median+ burst (p50 ~4 min, p90 ~17 min) — the turn gave up mid-burst.
 *   2. Worse, the budget was counted over a fixed 30-min sliding WINDOW, so
 *      once 3 retriggers landed, EVERY subsequent `-32603` in the next 30 min
 *      gave up with ZERO retries — i.e. an immediate user-facing leak on every
 *      failure for half an hour. Anchoring the budget to elapsed time since the
 *      first retrigger removes that "post-exhaustion sticky window" leak by
 *      construction: the same elapsed clock governs every decision in the
 *      burst, so there is no separate count that can saturate early.
 *
 * The returned backoff is taken from {@link RETRIGGER_BACKOFF_SCHEDULE_MS}
 * (indexed by `retriggerCount`, clamped to the last/capped 5-min entry). The
 * give-up decision is purely time-based: as long as `elapsedMs` is below the
 * budget a backoff is returned, so the final scheduled sleep may carry the
 * elapsed clock slightly past the budget — the NEXT failure then gives up. This
 * one-step overshoot is intentional (it costs at most one capped 5-min backoff)
 * and keeps the rule a trivial pure function.
 */
export const computeRetriggerBackoffMs = (retriggerCount: number, elapsedMs: number = 0): number | null => {
  if (elapsedMs >= RETRIGGER_BUDGET_MS) return null;
  const idx = Math.min(Math.max(retriggerCount, 0), RETRIGGER_BACKOFF_SCHEDULE_MS.length - 1);
  // idx is clamped into range, so the lookup is always defined; the `??` keeps
  // the type `number` under noUncheckedIndexedAccess.
  return RETRIGGER_BACKOFF_SCHEDULE_MS[idx] ?? RETRIGGER_BACKOFF_SCHEDULE_MS[RETRIGGER_BACKOFF_SCHEDULE_MS.length - 1]!;
};

/**
 * Returns true when a prompt error message indicates a watchdog-triggered
 * timeout that the retry path should react to. Covers the idle watchdog
 * (`'... idle for <n>s ...'`), the soft / hard wall-clock watchdogs
 * (`'... wall-clock ...'`), and the legacy wall-clock wording
 * (`'... timed out after 900s'`) still present in any persisted history.
 * Centralised in agent-core (`kiro-error-classification`); re-exported here
 * via a thin delegate so existing worker call-sites and tests keep their
 * import path unchanged.
 */
export const isPromptTimeoutOrIdleError = (msg: string): boolean => isPromptTimeoutOrIdleErrorShared(msg);

/**
 * Re-export the UX-sanitisation helpers from agent-core so worker call-sites
 * (and existing tests) can import them from this module.
 */
export { CANONICAL_KIRO_FAILURE_MESSAGE, isKnownKiroInternalError, toUserFacingTurnError };

/**
 * Detect permanent prompt errors that will never succeed on retry.
 * Mirrors the Bedrock path's `isPermanentError` logic.
 */
export const isKiroPermanentError = (msg: string): boolean => {
  const lower = msg.toLowerCase();
  return (
    lower.includes('invalid_request_error') ||
    lower.includes('validation_error') ||
    (lower.includes('image') && lower.includes('dimensions') && lower.includes('exceed'))
  );
};

export const getKiroPermanentErrorHint = (msg: string): string => {
  const lower = msg.toLowerCase();
  if (
    (lower.includes('image') && lower.includes('dimensions') && lower.includes('exceed')) ||
    (lower.includes('image') && lower.includes('size')) ||
    lower.includes('imagevalidationerror')
  ) {
    return 'The conversation has accumulated many images and hit the model API image size constraint.';
  }
  if (lower.includes('invalid_request_error') || lower.includes('validation')) {
    return 'The request content violated a model API constraint.';
  }
  return 'The request was permanently rejected.';
};

/**
 * Returns true when the permanent error is specifically an image-related
 * validation failure (dimension or size). Used to trigger session-file
 * invalidation and same-turn recovery so the session can resume.
 *
 * Deliberately BROADER than {@link isKiroPermanentError} (which stays narrow to
 * `dimensions+exceed`): the asymmetry is intentional main behaviour — the
 * recovery gate must catch `image+size` and `imagevalidationerror` too, while
 * the permanent-stop classifier must not widen (legacy parity).
 */
export const isImageDimensionError = (msg: string): boolean => {
  const lower = msg.toLowerCase();
  return (
    (lower.includes('image') && lower.includes('dimensions') && lower.includes('exceed')) ||
    (lower.includes('image') && lower.includes('size')) ||
    lower.includes('imagevalidationerror')
  );
};

/**
 * Delete kiro-cli's on-disk session files (both v2 and v3 layouts) for the
 * given session ID. This forces the next `session/load` to re-synthesise the
 * session from DDB history — recovering a session that was stuck on an
 * ImageValidationError. The v3 dir is resolved via the shared
 * {@link kiroV3SessionDir} so the deleted path is identical to the one
 * {@link kiroV3SessionFilesExist} inspects (single source of truth); otherwise
 * an invalidate would silently miss and the re-synthesis guard would not fire.
 *
 * Side-effecting (fs): errors are logged but not thrown so the turn can still
 * proceed. The sessionId is validated against
 * {@link SESSION_ID_PATTERN} before any path is built to prevent traversal.
 */
export const invalidateKiroSessionFiles = (sessionId: string, cwd: string): void => {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    console.warn(
      `[kiro-loop-helpers] invalidateKiroSessionFiles: invalid sessionId, skipping: ${JSON.stringify(sessionId)}`
    );
    return;
  }
  const home = process.env.HOME;
  if (!home) return;

  // v3 layout: $HOME/.kiro/sessions/<cwdHash>/<sessionId>/
  try {
    const v3Dir = kiroV3SessionDir(sessionId, cwd, home);
    if (existsSync(v3Dir)) {
      rmSync(v3Dir, { recursive: true, force: true });
      console.log(`[kiro-loop-helpers] invalidated v3 session files: ${v3Dir}`);
    }
  } catch (e) {
    console.warn(`[kiro-loop-helpers] failed to invalidate v3 session files for ${sessionId}:`, e);
  }

  // v2 layout: $HOME/.kiro/sessions/cli/<sessionId>.json(l)
  try {
    const v2Dir = `${home}/.kiro/sessions/cli`;
    const jsonPath = `${v2Dir}/${sessionId}.json`;
    const jsonlPath = `${v2Dir}/${sessionId}.jsonl`;
    if (existsSync(jsonPath)) {
      rmSync(jsonPath, { force: true });
      console.log(`[kiro-loop-helpers] invalidated v2 session json: ${jsonPath}`);
    }
    if (existsSync(jsonlPath)) {
      rmSync(jsonlPath, { force: true });
      console.log(`[kiro-loop-helpers] invalidated v2 session jsonl: ${jsonlPath}`);
    }
  } catch (e) {
    console.warn(`[kiro-loop-helpers] failed to invalidate v2 session files for ${sessionId}:`, e);
  }
};

/**
 * Normalise a tool name for the {@link IMAGE_READ_TOOL_NAMES} gate: strip
 * spaces, underscores and hyphens then lowercase so ACP v3 display names
 * ("Read File"), snake_case ("read_file") and camelCase ("readFile") all
 * collapse to the same key. Verbatim port from the legacy implementation — this is a
 * DIFFERENT normalisation from the shared tool-name-utils normaliser (that one
 * preserves separators), so it must NOT be reused here.
 */
export const normalizeToolNameForComparison = (name: string): string => name.toLowerCase().replace(/[\s_-]/g, '');

const IMAGE_READ_TOOL_NAMES = new Set(['readimage', 'readlocalimage', 'fsread', 'readfile']);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Whether a tool name (as advertised by kiro-cli ACP) is a known image reader.
 * Exported so the SDK loop's tool-result hook can gate capture on it.
 */
export const isImageReadToolName = (toolName: string): boolean =>
  IMAGE_READ_TOOL_NAMES.has(normalizeToolNameForComparison(toolName));

/**
 * Extract the image file path from a tool's rawInput, if it looks like an
 * image-reading tool invocation. Returns undefined if no recognisable path.
 */
export const extractImagePathFromToolInput = (toolName: string, rawInput: unknown): string | undefined => {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const input = rawInput as Record<string, unknown>;
  if (typeof input.imagePath === 'string') return input.imagePath;
  if (typeof input.path === 'string') {
    const p = input.path;
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return p;
  }
  const normalized = normalizeToolNameForComparison(toolName);
  if (normalized === 'fsread' || normalized === 'readfile') {
    const filePath =
      typeof input.path === 'string' ? input.path : typeof input.filePath === 'string' ? input.filePath : undefined;
    if (filePath) {
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) return filePath;
    }
  }
  return undefined;
};

const MAX_IMAGE_FILE_BYTES = 30 * 1024 * 1024; // 30 MB

/**
 * Attempt to persist a tool-read image to S3 (resized to ≤1568px via the
 * shared {@link ensureImageWithinBounds}) and return an image content block for
 * injection into the toolResult DDB item PLUS the resized S3 key for the live
 * `toolResult` webapp event. If the file doesn't exist, isn't a supported
 * image, exceeds the size limit, or resize fails, returns undefined (caller
 * falls back to text-only — best-effort, never breaks the tool result).
 */
export const persistToolReadImage = async (
  workerId: string,
  imagePath: string
): Promise<{ block: { image: { format: string; source: { s3Key: string } } }; s3Key: string } | undefined> => {
  try {
    if (!existsSync(imagePath)) return undefined;
    const ext = imagePath.slice(imagePath.lastIndexOf('.')).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return undefined;
    const stat = statSync(imagePath);
    if (stat.size > MAX_IMAGE_FILE_BYTES) {
      console.warn(
        `[kiro-loop-helpers] persistToolReadImage: ${imagePath} exceeds ${MAX_IMAGE_FILE_BYTES} bytes, skipping`
      );
      return undefined;
    }
    const raw = readFileSync(imagePath);
    const format =
      ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext === '.gif' ? 'gif' : ext === '.webp' ? 'webp' : 'png';
    const resized = await ensureImageWithinBounds(raw, { format });
    const hash = createHash('sha256').update(resized).digest('hex');
    const s3Key = `${workerId}/${hash}.${format}`;
    await writeBytesToKey(s3Key, resized);
    return { block: { image: { format, source: { s3Key } } }, s3Key };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[kiro-loop-helpers] persistToolReadImage failed for ${imagePath}: ${msg}`);
    return undefined;
  }
};

/**
 * Idle gap (ms) that separates one auto-recovery burst from the next. If more
 * than this elapses between consecutive `systemRetrigger` rows, the later row
 * starts a FRESH burst (and therefore a fresh time budget). Sized with
 * headroom above the largest scheduled backoff (5 min): a retry WITHIN one
 * burst is at most one capped backoff apart, but the wall-clock distance
 * between two persisted retrigger rows also includes the failed turn's own
 * runtime (the prompt attempt + its in-turn retry before `handleRetryFailure`
 * fires), so a 5-min backoff can land ~5.5+ min apart in practice. An 8-min
 * gap absorbs that overshoot without mis-splitting a single burst, while still
 * giving a session that recovered and ran cleanly for >8 min a clean slate.
 */
const RETRIGGER_BURST_GAP_MS = 8 * 60 * 1000; // 8 min (5-min max backoff + turn-runtime headroom)

/** Stats for the currently-active auto-recovery burst. */
export interface RetriggerBurstStats {
  /** Number of `systemRetrigger` rows already saved in the active burst. */
  count: number;
  /** Wall-clock ms since the FIRST retrigger of the active burst (0 when none). */
  elapsedMs: number;
}

/**
 * Pure burst-segmentation over `systemRetrigger` timestamps (ms, any order).
 * Walks the sorted timestamps and keeps only the trailing run whose adjacent
 * gaps are all <= `gapMs` (the active burst). Returns its size and the elapsed
 * time from its first member to `nowMs`. Exported so the budget windowing is
 * unit-testable without DynamoDB.
 *
 * A retrigger older than the active burst (separated by a > gapMs idle gap) is
 * intentionally excluded so a new burst starts with a full budget — the same
 * "recovered for a while -> fresh budget" intent the old sliding window had,
 * but anchored to burst boundaries rather than a fixed 30-min wall.
 */
export const computeRetriggerBurstStats = (
  retriggerTimestampsMs: number[],
  nowMs: number,
  gapMs: number = RETRIGGER_BURST_GAP_MS
): RetriggerBurstStats => {
  const sorted = [...retriggerTimestampsMs].filter((t) => Number.isFinite(t) && t <= nowMs).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, elapsedMs: 0 };
  // Find the start of the trailing burst: scan from the end, breaking when an
  // adjacent gap exceeds gapMs.
  let burstStartIdx = sorted.length - 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i]! - sorted[i - 1]! <= gapMs) {
      burstStartIdx = i - 1;
    } else {
      break;
    }
  }
  const burst = sorted.slice(burstStartIdx);
  return { count: burst.length, elapsedMs: nowMs - burst[0]! };
};

/**
 * Read the active auto-recovery burst stats from the worker's `systemRetrigger`
 * history. Replaces the old `countRecentRetriggers` (fixed 30-min sliding
 * window count) so the budget is governed by elapsed burst time, not a raw
 * count over a sticky window. Exported for unit testing.
 *
 * Retriggers at or before the most recent give-up marker
 * ({@link RETRIGGER_GIVEUP_MESSAGE_TYPE}) are excluded: once a burst exhausts
 * the budget and gives up, it is CLOSED, so a later failure (even one that
 * arrives within {@link RETRIGGER_BURST_GAP_MS} of the closed burst's tail)
 * starts a fresh budget with a full retry allowance. Without this, the old
 * burst's elapsed time would carry over and the very first retry of the new
 * failure would be denied — re-introducing the immediate post-exhaustion leak
 * this change exists to remove.
 */
export const getRetriggerBurstStats = async (
  workerId: string,
  nowMs: number = Date.now()
): Promise<RetriggerBurstStats> => {
  // includeAll: the give-up marker (RETRIGGER_GIVEUP_MESSAGE_TYPE) is filtered
  // out of the default history view, so we must read the raw rows to see it.
  const { items } = await getConversationHistory(workerId, { includeAll: true });
  const lastGiveupMs = items
    .filter((item) => item.messageType === RETRIGGER_GIVEUP_MESSAGE_TYPE)
    .map((item) => Number(item.SK))
    .filter((n) => Number.isFinite(n))
    .reduce((max, n) => (n > max ? n : max), 0);
  const timestamps = items
    .filter((item) => item.messageType === 'systemRetrigger')
    .map((item) => Number(item.SK))
    .filter((n) => Number.isFinite(n) && n > lastGiveupMs);
  return computeRetriggerBurstStats(timestamps, nowMs);
};

export const isKiroCliMode = (inferenceMode: string | undefined): inferenceMode is 'kiro-cli' => {
  return inferenceMode === 'kiro-cli';
};

/**
 * Kiro's ACP session is resume-based: on a `loaded` outcome kiro-cli
 * already carries its own conversation memory and we only forward the
 * newest user message. But when a previous turn was cancelled mid-flight
 * (the user sent another message that killed the active kiro-cli
 * subprocess), every user message the model never got to observe is
 * silently dropped — neither in kiro-cli's memory nor forwarded on the
 * next turn. To keep Kiro in parity with the Bedrock backend (which
 * re-sends the full history every turn through Converse), this helper
 * collapses every user-originated item that appeared after the most
 * recent assistant reply into a single synthetic "current turn"
 * MessageItem. Re-sending a message the model has already seen is
 * harmless; losing one is not.
 *
 * The combined ContentBlock[] preserves both text and image blocks so
 * the current-turn image-delivery path (see
 * `renderCurrentTurnIntoBuilder`) continues to work for cancelled
 * attachments. When 2+ text-carrying messages are concatenated a literal
 * `---` separator block is inserted between them so the model can still
 * tell the original message boundaries apart; a single-message tail is
 * passed through verbatim so its own `\n\n` paragraphs are not mangled.
 *
 * `consumedTailCount` reports the number of tail history items that must
 * be trimmed out of the CONVERSATION_HISTORY replay block on a `new`
 * session outcome. It covers the range [firstEligibleIdx, tail.end) so
 * that any interleaved / trailing tool-chain items (assistant toolUse +
 * user toolResult pairs from a cancelled prior turn) are trimmed along
 * with the eligible user messages they surround. Equivalently,
 *     historyForReplay = history.slice(0, history.length - consumedTailCount)
 *
 * ### Boundary: "completed assistant" rather than any assistant
 *
 * The walk-back stops at an assistant item whose content includes at
 * least one non-empty text block — i.e. a real model reply. Text-less
 * assistant items (a toolUse chain whose closing text was never persisted
 * because the turn was cancelled mid-flight) are passed over so the
 * whole unfinished chain folds into the current turn. Without this, a
 * cancelled mid-tool-chain turn would leave behind a (toolUse,
 * toolResult) pair as the only tail content, fail the eligibility filter
 * (neither is a user-originated messageType), fall through to the
 * `at(-1)` fallback (a toolResult with no renderable text/image), and
 * the caller's `hasRenderable` gate would silently skip the turn —
 * dropping every user message queued before the cancellation. This is
 * a regression observed in E2E testing (three rapid user messages
 * lost after a long tool chain got cancelled).
 *
 * When the tail contains no eligible items (the history ends with an
 * assistant reply and no newer user messages, or is empty) we fall back
 * to `history.at(-1)` — the orchestrator's canonical "current user
 * turn" item — and report `consumedTailCount === 0`, signalling the
 * caller to use the legacy slice-1 replay-trim behaviour. If the history
 * is completely empty the fallback is `undefined` and the caller's
 * `hasRenderable` gate skips the turn.
 *
 * Exported for unit testing.
 */
export const buildAggregatedCurrentTurn = (
  history: MessageItem[]
): { item: MessageItem | undefined; consumedTailCount: number } => {
  // Walk backwards to find the most recent *completed* assistant reply —
  // an assistant item whose content includes at least one non-empty text
  // block. Everything *after* that boundary is fair game for aggregation
  // into the current turn.
  //
  // Rationale: when a turn is cancelled mid-tool-chain, Kiro's agent loop
  // returns with `skipFinalize: true` and never persists the closing
  // assistant text, yet the per-tool `toolUse` / `toolResult` items WERE
  // persisted during streaming. A naive `role === 'assistant'` boundary
  // would stop at the last tool_use, leave only the trailing tool_result
  // in `tail`, fail the eligibility filter, and silently drop every user
  // message queued before the cancellation — the exact regression observed
  // in E2E testing (three rapid user messages disappeared because
  // tool_chain remnants from the cancelled prior turn acted as the
  // boundary). Treating an assistant with no text content as "not a real
  // reply" folds the whole unfinished tool chain into the current turn so
  // the queued user messages are re-aggregated and sent to kiro-cli.
  //
  // `consumedTailCount` is measured from the earliest eligible tail item
  // to the tail end so that the caller trims the entire unfinished tool
  // chain (assistant toolUse + user toolResult pairs interleaved with, or
  // trailing, the eligible user messages) out of the history-replay block.
  // Specifically:
  //     historyForReplay = history.slice(0, history.length - consumedTailCount)
  let lastAssistantIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const it = history[i]!;
    if (it.role !== 'assistant') continue;
    const blocks = parseContentBlocks(it.content);
    const hasText = blocks.some((b) => typeof b.text === 'string' && b.text.trim().length > 0);
    if (hasText) {
      lastAssistantIndex = i;
      break;
    }
    // Text-less assistant (tool_use only) — treat the whole unfinished
    // tool chain as not-a-reply and keep walking backwards.
  }
  const tailStart = lastAssistantIndex + 1;
  const tail = history.slice(tailStart);

  // First pass: locate eligible user-originated items AND the earliest of
  // them within the tail. The earliest index drives consumedTailCount so
  // trailing tool-chain items (toolUse / toolResult) are trimmed out of
  // the history replay along with the eligible user messages they
  // interleave with.
  let firstEligibleIdx = -1;
  const eligible: MessageItem[] = [];
  for (let i = 0; i < tail.length; i++) {
    const item = tail[i]!;
    if (item.role !== 'user') continue;
    if (!USER_INPUT_MESSAGE_TYPES.has(item.messageType)) continue;
    if (firstEligibleIdx === -1) firstEligibleIdx = i;
    eligible.push(item);
  }

  // No eligible tail items → defer to the orchestrator's canonical last
  // item. `consumedTailCount === 0` tells the caller to fall back to the
  // legacy slice-1 replay-trim behaviour.
  if (eligible.length === 0) {
    return { item: history.at(-1), consumedTailCount: 0 };
  }

  // consumedTailCount covers [firstEligibleIdx, tail.end) so the replay
  // trim also drops interleaved / trailing toolUse-toolResult pairs that
  // belonged to the cancelled-mid-turn tool chain.
  const consumedTailCount = tail.length - firstEligibleIdx;

  // A single eligible item is the common (non-cancelled) case; pass it
  // through verbatim so the item's own ContentBlock[] reaches the
  // renderer untouched and any internal `\n\n` paragraphs survive.
  if (eligible.length === 1) {
    return { item: eligible[0]!, consumedTailCount };
  }

  // 2+ eligible items → synthesize a combined MessageItem. Text blocks
  // across items are concatenated with a literal `---` separator block
  // so the model can still tell message boundaries apart; image and
  // file blocks are preserved in order so attachments survive a
  // mid-flight cancellation followed by re-aggregation. toolUse /
  // toolResult blocks are dropped — they are not expected on a user
  // role item of these messageTypes, and the renderer would skip them
  // anyway.
  const mergedBlocks: ContentBlock[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const itemBlocks = parseContentBlocks(eligible[i]!.content);
    if (i > 0) mergedBlocks.push({ text: '\n\n---\n\n' });
    for (const block of itemBlocks) {
      if (typeof block.text === 'string') mergedBlocks.push({ text: block.text });
      else if (block.image) mergedBlocks.push({ image: block.image });
      else if (block.file) mergedBlocks.push({ file: block.file });
    }
  }

  // Clone the most recent item as the synthetic template so the
  // messageType / slackUserId / senderUserId / SK travel through.
  // Downstream consumers only look at .role / .content / .messageType
  // (and optionally slackUserId on the orchestrator path that already
  // ran before we get here), so reusing the latest item's metadata is
  // the least-surprising choice.
  const latest = eligible[eligible.length - 1]!;
  const syntheticItem: MessageItem = {
    ...latest,
    content: JSON.stringify(mergedBlocks),
  };
  return { item: syntheticItem, consumedTailCount };
};

export const parseActiveProcessPid = (errorMessage: string): number | undefined => {
  // Be tolerant of quote/brackets variation: the JSON-RPC error is typically
  // stringified as `{"code":...,"message":"Session is active in another process (PID 904)"}`.
  const match = errorMessage.match(/Session is active in another process\s*\(PID\s+(\d+)\)/i);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isFinite(pid) || pid <= 1) return undefined;
  return pid;
};

/**
 * Read the process name (`comm`) for the given PID via `ps -p`. Returns
 * `undefined` when the process does not exist or the lookup fails — both
 * are treated as "do not attempt a kill" by the caller.
 *
 * Exported for unit testing (the runner injects a fake lookup in tests).
 */
export const getProcessComm = (
  pid: number,
  lookup: (pid: number) => string | undefined = defaultCommLookup
): string | undefined => {
  try {
    return lookup(pid);
  } catch {
    return undefined;
  }
};

const defaultCommLookup = (pid: number): string | undefined => {
  try {
    // `ps -p <pid> -o comm=` prints just the command name (no header).
    // `execFileSync` is used (not `exec`) so we don't invoke a shell, and
    // the pid is passed as a separate argv token so injection is not
    // possible even if the upstream parse were compromised.
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const comm = out.trim();
    return comm.length > 0 ? comm : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Read the kernel start-time (jiffies since boot, field 22 of
 * `/proc/<pid>/stat`) for the given PID. Used to distinguish a genuinely
 * stale kiro-cli process from a *recycled* PID: in the AgentCore microVM
 * the subprocess is repeatedly spawned at the same low PID (e.g. 67), so
 * PID identity alone is ambiguous. By comparing the start-time of the PID
 * named in a `session/load` lock error against the start-time observed now,
 * we can tell whether the lock-holder is still the same process instance.
 *
 * Returns `undefined` when `/proc` is unavailable (non-Linux, restricted
 * container) or the PID is gone — callers degrade gracefully without it.
 *
 * The 22nd whitespace-separated field is `starttime`. Field 2 (`comm`) is
 * wrapped in parentheses and may itself contain spaces/parentheses, so we
 * parse from the LAST `)` to avoid miscounting fields.
 *
 * Exported for unit testing.
 */
export const getProcessStartTime = (
  pid: number,
  read: (pid: number) => string | undefined = defaultStatRead
): number | undefined => {
  try {
    const raw = read(pid);
    if (!raw) return undefined;
    const rparen = raw.lastIndexOf(')');
    if (rparen < 0) return undefined;
    // Fields after `comm`: state is field 3, so the post-comm tokens start
    // at field 3. starttime is field 22 → index (22 - 3) = 19 in that list.
    const rest = raw
      .slice(rparen + 1)
      .trim()
      .split(/\s+/);
    const starttime = Number(rest[19]);
    return Number.isFinite(starttime) ? starttime : undefined;
  } catch {
    return undefined;
  }
};

const defaultStatRead = (pid: number): string | undefined => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Poll a foreign PID via `process.kill(pid, 0)` until it disappears
 * (`ESRCH`) or the timeout elapses. Used after `killStaleKiroProcess`
 * to wait for the kernel to release the kiro-cli session-lock files
 * before the next `session/load` retry. The previous fixed 500ms sleep
 * was both too long for the common case (lock release is sub-ms once
 * the process is gone) and too short for slow shutdowns.
 *
 * `process.kill(pid, 0)` does NOT signal the process; it merely
 * performs the standard "process exists?" probe. `ESRCH` confirms the
 * process is gone. `EPERM` means the process exists but we lack
 * permission to signal it — treat that as "still alive" and keep
 * polling.
 *
 * Returns `true` when the process is confirmed gone, `false` on
 * timeout. Timeout is a soft warning, not a hard failure: SIGKILL was
 * already dispatched, so the caller may proceed (the lock will release
 * shortly thereafter in the worst case).
 *
 * Exported for unit testing.
 */
export const waitForStalePidExit = async (
  pid: number,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    probe?: (pid: number) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<boolean> => {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 50;
  const probe = opts.probe ?? ((p: number) => process.kill(p, 0));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      probe(pid);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ESRCH') return true;
      // EPERM / other — process still alive (or unreadable). Keep polling.
    }
    await sleep(intervalMs);
  }
  return false;
};

/**
 * Outcome of {@link killStaleKiroProcess}.
 *   - `killed`        – SIGKILL was dispatched; the caller should wait for
 *                       the PID to exit and then retry `session/load`.
 *   - `gone`          – the PID is not running; the lock is stale on disk
 *                       only, so the caller may retry `session/load`.
 *   - `refused-self`  – the PID is (or is the same instance as) our own
 *                       live kiro-cli subprocess. Killing it would take our
 *                       own session down and the lock would never clear via
 *                       this path. The caller MUST NOT retry the same
 *                       locked sessionId — it should rotate to a fresh one.
 *   - `refused-other` – the PID exists but does not look like a kiro-cli
 *                       process (recycled PID), or SIGKILL failed. We do not
 *                       kill it; the caller should rotate rather than spin.
 */
export type StaleKillResult = 'killed' | 'gone' | 'refused-self' | 'refused-other';

/**
 * Attempt to reclaim a kiro-cli session lock held by another process.
 *
 * THE PID-REUSE TRAP (root cause of the production memory-loss loop): in the
 * AgentCore microVM, `kiro-cli` is respawned at a predictable low PID
 * (commonly 67). A `session/load` error of the form "Session is active in
 * another process (PID 67)" therefore frequently names OUR OWN live
 * subprocess (or a co-supervised daemon at the same recycled PID), not a
 * genuinely stale one. The previous implementation only checked
 * `comm == kiro-cli`, so it happily SIGKILLed PID 67 — i.e. shot itself in
 * the foot — and the lock never cleared, producing an infinite
 * `new-after-recovery-failure` loop. We now refuse to kill when the PID is
 * our own live subprocess (`livePid`).
 *
 * Safety measures (layered — each can veto the kill):
 *   1. The PID must have been parsed from a genuine `session/load` error.
 *   2. The PID must be > 1 (never target init or the current process).
 *   3. Must not be our own PID or our parent (don't suicide).
 *   4. Must not be our own *live kiro-cli subprocess* (`livePid`) — the
 *      critical PID-reuse guard. Returns `refused-self` so the caller
 *      rotates instead of looping.
 *   5. `ps -p <pid> -o comm=` must report a process name containing
 *      "kiro-cli" — otherwise we refuse (recycled PID).
 *
 * Exported for unit testing.
 */
export const killStaleKiroProcess = (
  pid: number,
  deps: {
    commLookup?: (pid: number) => string | undefined;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    /** PID of our own live kiro-cli subprocess, if any (never kill it). */
    livePid?: number | null;
    /** `/proc/<pid>/stat` start-time reader (injected in tests). */
    startTimeLookup?: (pid: number) => number | undefined;
  } = {}
): StaleKillResult => {
  // Guard rails first. Any failure returns a non-killed result.
  if (!Number.isFinite(pid) || pid <= 1) return 'refused-other';
  if (pid === process.pid || pid === process.ppid) {
    console.log(`[kiro-agent-loop] refusing to kill own/parent pid=${pid}`);
    return 'refused-self';
  }
  if (deps.livePid != null && pid === deps.livePid) {
    // The lock error names our OWN live kiro-cli subprocess. Killing it
    // would terminate the very session we are trying to load and the lock
    // would never clear. Signal the caller to rotate to a fresh sessionId.
    // The start-time (when /proc is available) only strengthens the
    // diagnostic log — PID equality with our tracked subprocess already
    // proves identity.
    const st = deps.startTimeLookup?.(pid);
    console.log(
      `[kiro-agent-loop] refusing to kill pid=${pid}: it is our own live kiro-cli subprocess` +
        (st !== undefined ? ` (starttime=${st})` : '') +
        ` (will rotate sessionId)`
    );
    return 'refused-self';
  }

  const comm = getProcessComm(pid, deps.commLookup);
  if (!comm) {
    // Process does not exist or lookup failed. Nothing to kill — treat
    // the retry as unblocked because the lock is likely stale on disk only.
    console.log(`[kiro-agent-loop] pid=${pid} not running (lock may be stale on disk)`);
    return 'gone';
  }
  if (!/kiro-cli/i.test(comm)) {
    console.log(`[kiro-agent-loop] refusing to kill pid=${pid}: comm="${comm}" does not look like kiro-cli`);
    return 'refused-other';
  }

  const killFn = deps.kill ?? ((p, s) => process.kill(p, s));
  try {
    killFn(pid, 'SIGKILL');
    console.log(`[kiro-agent-loop] SIGKILL sent to stale kiro-cli pid=${pid} (comm=${comm})`);
    return 'killed';
  } catch (e) {
    console.log(`[kiro-agent-loop] SIGKILL failed for pid=${pid}: ${e instanceof Error ? e.message : String(e)}`);
    return 'refused-other';
  }
};

export const normalizeKiroToolName = (raw: string): string => {
  let work = raw;
  // 1. Strip a leading "<word>: " status prefix. The verbs kiro-cli is
  //    known to emit include "Running", "Executing", "Creating",
  //    "Reading", "Writing", "Updating", "Deleting". Rather than
  //    enumerate, accept any leading word followed by ": " so future
  //    additions in kiro-cli do not require an update here.
  const statusPrefix = work.match(/^([A-Za-z][A-Za-z0-9]*):\s+(.*)$/);
  if (statusPrefix) {
    work = statusPrefix[2]!;
  }
  // 2. Strip a leading "@<namespace>/" MCP prefix.
  const mcpPrefix = work.match(/^@[^/]+\/(.+)$/);
  if (mcpPrefix) {
    work = mcpPrefix[1]!;
  }
  return work;
};

/**
 * ============================================================================
 * Failure-class-aware in-turn retry ladder
 * ============================================================================
 * The SDK loop (`kiroAcpSdkAgentLoop`) previously retried a failed
 * `session/prompt` exactly ONCE (any non-permanent error) with a fresh
 * subprocess, then fell straight through to the cross-turn auto-retrigger.
 * That single generic retry is too shallow for the real kiro-cli failure
 * modes: a wedged subprocess, a died subprocess, a `-32603` internal error,
 * and a watchdog idle-timeout each want their OWN small budget so one
 * transient class cannot burn the (single) retry that another class needs.
 *
 * `classifyKiroFailure` buckets a raw prompt-error message into a stable set
 * of classes; the loop keeps an independent per-class counter (loop-local, so
 * a completed turn naturally resets every budget) and retries up to
 * `KIRO_ACP_RETRY_MAX_PER_CLASS` (default 3) times per class before falling
 * through to the existing time-based auto-retrigger. `permanent` never
 * retries; `empty-response` only participates when explicitly enabled (see
 * `emptyResponseRetryEnabled`).
 *
 * These two functions are pure + exported so the ladder policy is unit-tested
 * against the REAL production decision code (Test Effectiveness Rule) without
 * spinning up a subprocess.
 */
export type KiroFailureClass =
  | 'permanent'
  | 'process-died'
  | 'wedged'
  | 'busy'
  | 'hard-wall'
  | 'idle-timeout'
  | 'empty-response'
  | 'unknown';

/** Marker the loop uses to signal an (otherwise successful) empty response into the ladder. */
export const EMPTY_RESPONSE_ERROR = 'kiro-cli returned an empty response (no text, no tool calls)';

/**
 * Classify a raw prompt-failure message into a {@link KiroFailureClass}.
 * Order matters — the most specific / most consequential class wins:
 *   1. permanent      — validation / image-size errors that never succeed on
 *                        retry (delegates to {@link isKiroPermanentError}).
 *   2. empty-response — the loop's synthetic {@link EMPTY_RESPONSE_ERROR}.
 *   3. process-died   — the subprocess exited mid-prompt.
 *   4. wedged         — the bounded settle wait timed out (the reused
 *                        subprocess never settled the previous prompt).
 *                        Checked before `busy` because its marker text quotes
 *                        the "Prompt already in progress" phrase.
 *   5. busy           — kiro-cli `-32603 "Prompt already in progress"` (a new
 *                        prompt was issued while the previous was still in
 *                        progress at the kiro-cli level).
 *   6. idle-timeout   — idle / wall-clock watchdog fired
 *                        (delegates to {@link isPromptTimeoutOrIdleError}).
 *   7. unknown        — any other error; still retryable (network transient,
 *                        a generic `-32603` internal error, etc.).
 *
 * Pure. Exported for unit testing.
 */
export const classifyKiroFailure = (msg: string): KiroFailureClass => {
  if (isKiroPermanentError(msg)) return 'permanent';
  if (msg.includes(EMPTY_RESPONSE_ERROR)) return 'empty-response';
  if (msg.includes('process died') || msg.includes('Kiro CLI process died')) return 'process-died';
  // Check the wedged settle-error marker BEFORE the raw "Prompt already in
  // progress" busy signal: PROMPT_SETTLE_WEDGED_ERROR's own text quotes that
  // phrase, so the more specific wedged marker must win.
  if (msg.includes(PROMPT_SETTLE_WEDGED_ERROR) || msg.includes('subprocess wedged')) return 'wedged';
  if (msg.includes('Prompt already in progress')) return 'busy';
  // The HARD wall-clock ceiling is a runaway/infinite-loop guard, not a
  // transient hiccup — retrying it in-turn (3×) just burns another full
  // hard-wall window each time. Classify it separately (before idle-timeout,
  // which also matches the 'wall-clock' substring) so the ladder can decline to
  // retry it and fall straight through to the cross-turn auto-retrigger.
  if (msg.includes('hard wall-clock')) return 'hard-wall';
  if (isPromptTimeoutOrIdleErrorShared(msg)) return 'idle-timeout';
  return 'unknown';
};

/**
 * Parse a non-negative integer from an env var, falling back to `fallback`
 * when unset / empty / not a finite non-negative number. Shared by the retry
 * ladder and the probe/reuse timeout tunables.
 */
export const parseIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/**
 * Parse a boolean-ish env var. `undefined`/empty → `fallback`. Recognised
 * truthy: `1`, `true`, `on`, `yes` (case-insensitive). Recognised falsy:
 * `0`, `false`, `off`, `no`. Anything else → `fallback`.
 */
export const parseBoolEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return fallback;
};

/** Max in-turn retries per failure class (env `KIRO_ACP_RETRY_MAX_PER_CLASS`, default 3). */
export const kiroRetryMaxPerClass = (): number => parseIntEnv('KIRO_ACP_RETRY_MAX_PER_CLASS', 3);

/**
 * Turn-level cap on the TOTAL number of in-turn retries across ALL classes
 * (env `KIRO_ACP_RETRY_MAX_TOTAL`, default 6 — a conservative bound above the
 * per-class default so a single class can still use its 3 while a genuinely
 * flapping turn cannot spin the subprocess indefinitely). Once the total is
 * reached the ladder gives up and hands off to the cross-turn auto-retrigger.
 */
export const kiroRetryMaxTotal = (): number => parseIntEnv('KIRO_ACP_RETRY_MAX_TOTAL', 6);

/**
 * Whether the `empty-response` class participates in the in-turn ladder
 * (env `KIRO_ACP_RETRY_EMPTY_RESPONSE`, default OFF). Kept off by default
 * because a genuinely intentional silent turn (wake-up silent-terminate) is a
 * DESIGNED normal behaviour in this system — retrying it risks re-emitting a
 * duplicate message. When off, the loop keeps its existing `emptyTurn()`
 * short-circuit.
 */
export const emptyResponseRetryEnabled = (): boolean => parseBoolEnv('KIRO_ACP_RETRY_EMPTY_RESPONSE', false);

/** Outcome of {@link decideRetryLadder}. */
export type RetryLadderDecision = 'permanent' | 'retry' | 'giveup';

/**
 * Pure per-class ladder decision. Given the failure class and the
 * already-recorded per-class attempt counts (BEFORE recording the current
 * failure), decide whether the loop should:
 *   - `'permanent'` — never retry (surface immediately);
 *   - `'giveup'`    — this class has exhausted its budget → fall through to the
 *                     cross-turn auto-retrigger;
 *   - `'retry'`     — dispose + respawn + re-attempt within the same turn.
 *
 * `empty-response` gives up immediately unless `emptyResponseRetryEnabled` is
 * true. The caller is responsible for incrementing `counts[cls]` when this
 * returns `'retry'`.
 *
 * Pure. Exported for unit testing.
 */
export const decideRetryLadder = (
  cls: KiroFailureClass,
  counts: Partial<Record<KiroFailureClass, number>>,
  opts: { maxPerClass: number; emptyResponseEnabled: boolean; maxTotal?: number; toolActivityThisAttempt?: boolean }
): RetryLadderDecision => {
  if (cls === 'permanent') return 'permanent';
  // The hard wall-clock ceiling is never retried in-turn (runaway guard) —
  // hand straight to the cross-turn auto-retrigger.
  if (cls === 'hard-wall') return 'giveup';
  if (cls === 'empty-response' && !opts.emptyResponseEnabled) return 'giveup';
  // If this attempt already performed tool activity (persisted a toolUse),
  // its side effects are not safe to blindly re-execute on a fresh in-turn
  // attempt — fall through to the auto-retrigger (history re-synthesis) path.
  if (opts.toolActivityThisAttempt) return 'giveup';
  // Total-attempt cap across all classes.
  if (opts.maxTotal !== undefined) {
    const total = Object.values(counts).reduce((a, n) => a + (n ?? 0), 0);
    if (total >= opts.maxTotal) return 'giveup';
  }
  const used = counts[cls] ?? 0;
  return used < opts.maxPerClass ? 'retry' : 'giveup';
};
