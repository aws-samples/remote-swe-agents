/**
 * Synthesise a kiro-cli ACP session on disk from the worker's DynamoDB
 * conversation history so a fresh kiro-cli subprocess can resume the
 * conversation via `session/load` instead of forcing a `session/new` +
 * lossy text replay.
 *
 * Background
 * ----------
 * kiro-cli persists ACP sessions as a pair of files keyed by sessionId:
 *
 *   $HOME/.kiro/sessions/cli/<sessionId>.json   (metadata)
 *   $HOME/.kiro/sessions/cli/<sessionId>.jsonl  (event log, append-only)
 *
 * Bedrock AgentCore does NOT mount a persistent volume, so when the
 * runtime container is recycled, both files vanish and the next worker
 * invocation finds kiro-cli in a virgin state. Without intervention the
 * worker would call `session/load` against a sessionId kiro-cli has never
 * heard of, the call fails, and the worker historically fell back to
 * `session/new` while shovelling the entire DDB history into the system
 * prompt as text (delimited with `<|TOOL_USE|>`, `<|USER|>`, `<|ASSISTANT|>`
 * etc.). That format conditioned the model into emitting the same tokens
 * verbatim — the leak this module is designed to make impossible.
 *
 * The synthesis approach removes the text replay entirely: before the
 * worker calls `session/load`, it materialises the two session files from
 * DDB messages so kiro-cli's load succeeds and the Agent sends
 * `session/update` notifications back to replay the history natively.
 *
 * Schema reference (verified empirically against kiro-cli 2.x):
 *   - Prompt          { kind: 'Prompt',          data: { message_id, content[], meta:{timestamp} } }
 *   - AssistantMessage{ kind: 'AssistantMessage',data: { message_id, content[] } }
 *   - ToolResults     { kind: 'ToolResults',     data: { message_id, content[], results:{<id>:{tool,result}} } }
 *
 * The `results` map carries the tool dispatch metadata kiro-cli's agent
 * loop validates on every turn after a load. Omitting it triggers a
 * panic ("invalid conversation history received"). For MCP tools the
 * worker's tool catalogue has no first-class kiro-cli builtin, so every
 * synthesised result uses `kind.Mcp.{toolName, serverName, params}` —
 * kiro-cli accepts arbitrary serverName / toolName here as long as the
 * shape is right.
 *
 * Invariant violations kiro-cli enforces (binary-string-derived):
 *   - invalid_first_message            (must start with Prompt)
 *   - user_not_followed_by_assistant   (Prompt → Prompt is illegal)
 *   - assistant_not_followed_by_user   (Assistant → Assistant is illegal except after ToolResults)
 *   - orphaned_tool_results            (ToolResults without matching toolUse)
 *   - missing_tool_results             (toolUse without matching ToolResults)
 *
 * The `synthesizeKiroSessionFiles` function below normalises a raw DDB
 * MessageItem stream into a sequence that satisfies all of those rules,
 * dropping unreconcilable items with a warning.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';
import { USER_INPUT_MESSAGE_TYPES } from '@remote-swe-agents/agent-core/schema';
import { BucketName } from '@remote-swe-agents/agent-core/aws';
import { materializeImageBlock } from '@remote-swe-agents/agent-core/lib';

/**
 * Injection point for materialising an image S3 key into local paths.
 * Defaults to the agent-core `materializeImageBlock` which fetches from S3,
 * resizes to ≤1568px, and writes a JPEG preview to `/tmp/.remote-swe-images/`.
 * Tests inject a mock to avoid real S3 IO.
 */
export type MaterializeImageFn = (
  s3Key: string
) => Promise<{ originalPath: string; previewPath: string; fileName: string; s3Uri: string }>;

/**
 * Maximum number of turns to keep in the synthesised session as a
 * defensive truncation when the full history cannot be normalised
 * cleanly. A "turn" is one user prompt and the assistant response that
 * follows (which may contain any number of toolUse / toolResult pairs).
 *
 * Set deliberately high so day-to-day sessions are reproduced in full;
 * this only kicks in when invariant repairs cause the converter to
 * progressively shrink the event list to find a kiro-cli-acceptable
 * prefix. Tunable per-call via the `maxTurnsFallback` option.
 */
export const DEFAULT_MAX_TURNS_FALLBACK = 200;

/**
 * Server name attached to every synthesised MCP tool result. kiro-cli
 * does not validate this against the actually-attached MCP servers on
 * `session/load`, so a fixed marker is sufficient and keeps the
 * resulting jsonl deterministic.
 */
const SYNTH_MCP_SERVER_NAME = 'remote-swe';

interface RawContentBlock {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input?: unknown };
  toolResult?: {
    toolUseId?: string;
    content?: Array<{ text?: string; json?: unknown }>;
    status?: string;
  };
  image?: { format?: string; source?: { s3Key?: string } };
  file?: { fileName?: string; mimeType?: string; size?: number; source?: { s3Key?: string } };
}

const parseContent = (raw: string): RawContentBlock[] => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RawContentBlock[]) : [];
  } catch {
    // Legacy non-JSON rows: surface as a single text block so we don't
    // silently lose data when extracting prompts.
    return [{ text: raw }];
  }
};

type KiroJsonContent =
  | { kind: 'text'; data: string }
  | { kind: 'toolUse'; data: { toolUseId: string; name: string; input: unknown } }
  | { kind: 'json'; data: unknown };

type KiroJsonlEvent =
  | {
      version: 'v1';
      kind: 'Prompt';
      data: {
        message_id: string;
        content: Array<{ kind: 'text'; data: string }>;
        meta: { timestamp: number };
      };
    }
  | {
      version: 'v1';
      kind: 'AssistantMessage';
      data: {
        message_id: string;
        content: KiroJsonContent[];
      };
    }
  | {
      version: 'v1';
      kind: 'ToolResults';
      data: {
        message_id: string;
        content: Array<{
          kind: 'toolResult';
          data: {
            toolUseId: string;
            content: Array<{ kind: 'text' | 'json'; data: unknown }>;
            status: 'success' | 'error';
          };
        }>;
        results: Record<
          string,
          {
            tool: {
              tool_use_purpose: string | null;
              kind: { Mcp: { toolName: string; serverName: string; params: unknown } };
            };
            result: { Success: { items: Array<{ Text: string } | { Json: unknown }> } };
          }
        >;
      };
    };

interface IntermediateUserEvent {
  type: 'user';
  text: string;
  timestamp: number;
  /**
   * Source SK of the FIRST item folded into this user event. Used for
   * deterministic ordering when merging consecutive user-side messages.
   */
  sk: string;
}

interface IntermediateAssistantTextEvent {
  type: 'assistantText';
  text: string;
  sk: string;
}

interface IntermediateAssistantToolUseEvent {
  type: 'assistantToolUse';
  toolUses: Array<{ toolUseId: string; name: string; input: unknown }>;
  /**
   * Inline assistant text that appeared alongside the toolUse in the
   * original DDB row (or rows). Some Bedrock turns produce a short
   * preface like "OK, doing X" before the toolUse block.
   */
  inlineText?: string;
  sk: string;
}

interface IntermediateToolResultEvent {
  type: 'toolResult';
  results: Array<{
    toolUseId: string;
    content: Array<{ kind: 'text' | 'json'; data: unknown }>;
    status: 'success' | 'error';
  }>;
  sk: string;
}

type IntermediateEvent =
  | IntermediateUserEvent
  | IntermediateAssistantTextEvent
  | IntermediateAssistantToolUseEvent
  | IntermediateToolResultEvent;

/**
 * Message types whose `content` payload is folded into a user-role
 * Prompt event. Sourced from
 * `agent-core/schema`'s {@link USER_INPUT_MESSAGE_TYPES} so this module
 * and the live tail aggregation in `kiro-agent-loop.ts` cannot drift —
 * if they did, a single DDB MessageItem could end up both replayed via
 * synthesis AND folded into the new turn, producing duplicate user
 * input from kiro-cli's perspective.
 *
 * `communicationLog` is intentionally NOT in this set: those entries
 * are sibling-to-sibling agent traffic mirrored to the parent session
 * for UI display only, and `getConversationHistory` already filters
 * them out of the LLM context (`includeAll: false`). Including them
 * here would re-introduce them via the synthesised replay block.
 */
const USER_ROLE_TYPES = USER_INPUT_MESSAGE_TYPES;

const skToTimestamp = (sk: string): number => {
  // SK is a stringified milliseconds timestamp (zero-padded). Convert to
  // seconds because kiro-cli's Prompt.meta.timestamp is unix seconds.
  const ms = Number.parseInt(sk, 10);
  if (!Number.isFinite(ms) || ms <= 0) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
};

const collapseText = (parts: string[]): string => {
  return parts
    .map((p) => p ?? '')
    .filter((p) => p.length > 0)
    .join('\n\n');
};

/**
 * Pass 1: walk DDB items in SK order and emit an intermediate event per
 * item. No invariant repairs yet — that happens in pass 2.
 *
 * Image blocks with an S3 key are materialised into local filesystem paths
 * (original + resized preview ≤1568px) so the model retains visual context
 * across session recovery. The materialisation is async (S3 fetch + sharp
 * resize); failures are swallowed and degraded to a text placeholder so one
 * missing S3 object does not poison the entire synthesis.
 *
 * File blocks remain text-placeholder-only because the model does not need
 * to "see" arbitrary binary files — a filename reference is sufficient.
 */
const buildIntermediateEvents = async (
  items: MessageItem[],
  materializeImage: MaterializeImageFn = materializeImageBlock
): Promise<IntermediateEvent[]> => {
  const events: IntermediateEvent[] = [];

  for (const item of items) {
    const blocks = parseContent(item.content);
    if (blocks.length === 0) continue;

    const mt = item.messageType;
    const sk = item.SK;

    if (USER_ROLE_TYPES.has(mt)) {
      const parts: string[] = [];
      for (const b of blocks) {
        if (typeof b.text === 'string' && b.text.length > 0) {
          parts.push(b.text);
        } else if (typeof b.image?.source?.s3Key === 'string' && b.image.source.s3Key.length > 0) {
          const imgS3Key = b.image.source.s3Key;
          try {
            const { previewPath, fileName, s3Uri } = await materializeImage(imgS3Key);
            parts.push(
              `the image "${fileName}" is available as a resized preview at ${previewPath} (original: ${s3Uri})\n` +
                `to view this image, use the readLocalImage tool on the preview path`
            );
          } catch {
            const s3Uri = BucketName ? `s3://${BucketName}/${imgS3Key}` : imgS3Key;
            parts.push(`[image attachment, s3Key: ${imgS3Key}, s3Uri: ${s3Uri}]`);
          }
        } else if (typeof b.file?.source?.s3Key === 'string' && b.file.source.s3Key.length > 0) {
          const fileName = b.file.fileName || b.file.source.s3Key.split('/').pop() || 'file';
          parts.push(`[file attachment: ${fileName}]`);
        }
      }
      const text = collapseText(parts);
      if (text.length === 0) continue;
      events.push({ type: 'user', text, timestamp: skToTimestamp(sk), sk });
      continue;
    }

    if (mt === 'assistant') {
      const text = collapseText(blocks.map((b) => b.text ?? '').filter((t) => t.length > 0));
      if (text.length === 0) continue;
      events.push({ type: 'assistantText', text, sk });
      continue;
    }

    if (mt === 'toolUse') {
      const toolUses: Array<{ toolUseId: string; name: string; input: unknown }> = [];
      const textParts: string[] = [];
      for (const b of blocks) {
        if (b.text && b.text.length > 0) textParts.push(b.text);
        if (b.toolUse) {
          toolUses.push({
            toolUseId: b.toolUse.toolUseId ?? `tooluse_synth_${randomUUID().slice(0, 8)}`,
            name: b.toolUse.name ?? 'unknown',
            input: b.toolUse.input ?? {},
          });
        }
      }
      if (toolUses.length === 0 && textParts.length === 0) continue;
      if (toolUses.length === 0) {
        events.push({ type: 'assistantText', text: collapseText(textParts), sk });
      } else {
        events.push({
          type: 'assistantToolUse',
          toolUses,
          inlineText: textParts.length > 0 ? collapseText(textParts) : undefined,
          sk,
        });
      }
      continue;
    }

    if (mt === 'toolResult') {
      const results: IntermediateToolResultEvent['results'] = [];
      for (const b of blocks) {
        if (!b.toolResult) continue;
        const tr = b.toolResult;
        const tu = tr.toolUseId ?? '';
        if (!tu) continue; // unrecoverable: cannot pair an orphan
        const content: Array<{ kind: 'text' | 'json'; data: unknown }> = [];
        for (const c of tr.content ?? []) {
          if (typeof c.text === 'string') content.push({ kind: 'text', data: c.text });
          else if (c.json !== undefined) content.push({ kind: 'json', data: c.json });
          else if (typeof (c as any).image?.source?.s3Key === 'string') {
            const imgS3Key = (c as any).image.source.s3Key as string;
            try {
              const { previewPath, fileName, s3Uri } = await materializeImage(imgS3Key);
              content.push({
                kind: 'text',
                data:
                  `the image "${fileName}" is available as a resized preview at ${previewPath} (original: ${s3Uri})\n` +
                  `to view this image, use the readLocalImage tool on the preview path`,
              });
            } catch {
              const s3Uri = BucketName ? `s3://${BucketName}/${imgS3Key}` : imgS3Key;
              content.push({ kind: 'text', data: `[image in tool result, s3Key: ${imgS3Key}, s3Uri: ${s3Uri}]` });
            }
          }
        }
        if (content.length === 0) {
          // Empty tool result still needs SOME content so the resulting
          // jsonl is well-formed; kiro-cli accepts an empty text block.
          content.push({ kind: 'text', data: '' });
        }
        results.push({ toolUseId: tu, content, status: tr.status === 'error' ? 'error' : 'success' });
      }
      if (results.length === 0) continue;
      events.push({ type: 'toolResult', results, sk });
      continue;
    }

    // Unknown messageType: skip (forwards-compatible).
  }

  return events;
};

interface NormaliseStats {
  droppedOrphanToolUses: number;
  droppedOrphanToolResults: number;
  mergedConsecutiveUsers: number;
  truncatedToTailTurns: number;
  /** Total intermediate events the converter started with. */
  inputCount: number;
  /** Final emitted jsonl event count. */
  emittedCount: number;
}

const newStats = (): NormaliseStats => ({
  droppedOrphanToolUses: 0,
  droppedOrphanToolResults: 0,
  mergedConsecutiveUsers: 0,
  truncatedToTailTurns: 0,
  inputCount: 0,
  emittedCount: 0,
});

/**
 * Pass 2: enforce kiro-cli's strict alternation invariants. Returns a
 * possibly-shorter event list ready to be serialised to jsonl.
 *
 * Algorithm:
 *   1. Drop leading non-user events (invalid_first_message).
 *   2. Walk forward maintaining a "next expected role" cursor.
 *      - Expecting user: accept user (merge consecutive), reject anything else.
 *      - Expecting assistant: accept assistantText / assistantToolUse;
 *        if assistantToolUse, the next event MUST be toolResult covering
 *        every toolUseId. After ToolResults we still expect another
 *        assistant event before the next user (kiro-cli requires every
 *        toolUse/toolResult cycle to terminate with an assistant text /
 *        toolUse before user can speak again). If the recorded stream
 *        skipped that closing assistant, synthesise an empty placeholder.
 *   3. If at any point the stream cannot satisfy the next-expected role,
 *      drop the offending event with a warn-level log.
 */
const normaliseEvents = (events: IntermediateEvent[], stats: NormaliseStats): IntermediateEvent[] => {
  // Step 1: collect tooluse ids declared by assistantToolUse events and
  // ids satisfied by toolResult events. Drop both sides of any unmatched
  // pair before invariant checking — leaving an orphan would force the
  // walker into an unrecoverable error path later.
  const declaredToolUseIds = new Set<string>();
  const satisfiedToolUseIds = new Set<string>();
  for (const ev of events) {
    if (ev.type === 'assistantToolUse') {
      for (const tu of ev.toolUses) declaredToolUseIds.add(tu.toolUseId);
    } else if (ev.type === 'toolResult') {
      for (const r of ev.results) satisfiedToolUseIds.add(r.toolUseId);
    }
  }

  const toolUseIdsKept = new Set<string>();
  for (const id of declaredToolUseIds) {
    if (satisfiedToolUseIds.has(id)) toolUseIdsKept.add(id);
  }

  const cleaned: IntermediateEvent[] = [];
  for (const ev of events) {
    if (ev.type === 'assistantToolUse') {
      const filtered = ev.toolUses.filter((tu) => toolUseIdsKept.has(tu.toolUseId));
      const dropped = ev.toolUses.length - filtered.length;
      stats.droppedOrphanToolUses += dropped;
      if (filtered.length === 0) {
        if (ev.inlineText && ev.inlineText.length > 0) {
          cleaned.push({ type: 'assistantText', text: ev.inlineText, sk: ev.sk });
        }
        continue;
      }
      cleaned.push({ ...ev, toolUses: filtered });
      continue;
    }
    if (ev.type === 'toolResult') {
      const filtered = ev.results.filter((r) => toolUseIdsKept.has(r.toolUseId));
      const dropped = ev.results.length - filtered.length;
      stats.droppedOrphanToolResults += dropped;
      if (filtered.length === 0) continue;
      cleaned.push({ ...ev, results: filtered });
      continue;
    }
    cleaned.push(ev);
  }

  // Step 2: drop leading non-user events.
  let firstUserIdx = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i]!.type === 'user') {
      firstUserIdx = i;
      break;
    }
  }
  if (firstUserIdx === -1) return [];
  const tail = cleaned.slice(firstUserIdx);

  // Step 3: walk and enforce alternation.
  const out: IntermediateEvent[] = [];
  type Expect = 'user' | 'assistantOrToolResult' | 'assistantClose';
  let expect: Expect = 'user';

  for (let i = 0; i < tail.length; i++) {
    const ev = tail[i]!;

    if (expect === 'user') {
      if (ev.type === 'user') {
        // Merge with the previous user event if it's already open at the
        // tail of `out`, instead of pushing a sibling Prompt that would
        // violate the invariant. We replace the array slot with a fresh
        // object rather than mutating the existing one so callers that
        // share the input array (or reuse the input event objects) do
        // not observe `text` field surgery as a side effect.
        const last = out[out.length - 1];
        if (last && last.type === 'user') {
          out[out.length - 1] = { ...last, text: collapseText([last.text, ev.text]) };
          stats.mergedConsecutiveUsers++;
        } else {
          out.push(ev);
        }
        expect = 'assistantOrToolResult';
      }
      // Anything else here would be illegal (Assistant before User /
      // orphaned ToolResults). Drop silently — orphan accounting was
      // already recorded in step 1 for tool events; for assistantText
      // before any user, there's no useful place to put it.
      continue;
    }

    if (expect === 'assistantOrToolResult') {
      if (ev.type === 'assistantText') {
        out.push(ev);
        expect = 'user';
        continue;
      }
      if (ev.type === 'assistantToolUse') {
        out.push(ev);
        // After a toolUse the next event MUST be a toolResult covering
        // every declared toolUseId.
        const declared = new Set(ev.toolUses.map((t) => t.toolUseId));
        const next = tail[i + 1];
        if (next && next.type === 'toolResult' && next.results.every((r) => declared.has(r.toolUseId))) {
          out.push(next);
          i++;
          expect = 'assistantClose';
        } else {
          // Missing toolResult — synthesise empty success results so the
          // toolUse isn't orphaned. This is a last-resort repair; the
          // upstream filter in step 1 should have prevented it.
          const synthResults: IntermediateToolResultEvent['results'] = ev.toolUses.map((t) => ({
            toolUseId: t.toolUseId,
            content: [{ kind: 'text', data: '' }],
            status: 'success',
          }));
          out.push({ type: 'toolResult', results: synthResults, sk: ev.sk });
          expect = 'assistantClose';
        }
        continue;
      }
      if (ev.type === 'user') {
        // Two consecutive user events means the previous user turn was
        // never replied to (e.g. the orchestrator ingested several
        // sibling-agent messages back-to-back before the model had a
        // chance to respond). Folding them into the existing user event
        // matches what `buildAggregatedCurrentTurn` does for the live
        // turn, and keeps the alternation invariant satisfied without
        // injecting a meaningless empty assistant placeholder. Replace
        // the array slot with a fresh object so input-array aliasing
        // never produces a hidden side effect on the caller.
        const last = out[out.length - 1];
        if (last && last.type === 'user') {
          out[out.length - 1] = { ...last, text: collapseText([last.text, ev.text]) };
          stats.mergedConsecutiveUsers++;
          // expect stays 'assistantOrToolResult'.
        } else {
          // Cannot merge (no immediately preceding user — should not
          // happen because we just transitioned from accepting a user)
          // — synthesise an empty assistant boundary so the new user
          // isn't lost.
          out.push({ type: 'assistantText', text: '', sk: ev.sk });
          out.push(ev);
          expect = 'assistantOrToolResult';
        }
        continue;
      }
      // toolResult while we expected an assistant — already filtered
      // above, drop.
      continue;
    }

    if (expect === 'assistantClose') {
      if (ev.type === 'assistantText' || ev.type === 'assistantToolUse') {
        out.push(ev);
        // Another toolUse → loop again.
        if (ev.type === 'assistantToolUse') {
          const declared = new Set(ev.toolUses.map((t) => t.toolUseId));
          const next = tail[i + 1];
          if (next && next.type === 'toolResult' && next.results.every((r) => declared.has(r.toolUseId))) {
            out.push(next);
            i++;
            // remain 'assistantClose'
          } else {
            const synthResults: IntermediateToolResultEvent['results'] = ev.toolUses.map((t) => ({
              toolUseId: t.toolUseId,
              content: [{ kind: 'text', data: '' }],
              status: 'success',
            }));
            out.push({ type: 'toolResult', results: synthResults, sk: ev.sk });
          }
        } else {
          expect = 'user';
        }
        continue;
      }
      if (ev.type === 'user') {
        // Closing assistant text was not recorded in DDB — synthesise an
        // empty one so the next user prompt sits on a valid boundary.
        out.push({ type: 'assistantText', text: '', sk: ev.sk });
        out.push(ev);
        expect = 'assistantOrToolResult';
        continue;
      }
      // Stray toolResult — drop, already counted above.
      continue;
    }
  }

  // Tail clean-up: a trailing dangling assistantToolUse (without
  // matching toolResult) is impossible by construction above, but a
  // trailing user without an assistant follow-up is possible. kiro-cli
  // tolerates a session whose last event is a user Prompt — that's the
  // exact shape `session/new` would produce after the first user prompt
  // was streamed in. So we leave a trailing user event in place.
  return out;
};

const trimToTailTurns = (events: IntermediateEvent[], maxTurns: number, stats: NormaliseStats): IntermediateEvent[] => {
  if (maxTurns <= 0) return events;
  // A "turn" begins with a user event. Walk backwards counting turns
  // and stop at the user event that becomes the new head of the kept
  // window — that way the resulting slice always starts with a Prompt,
  // satisfying kiro-cli's `invalid_first_message` invariant.
  let turnsSeen = 0;
  let cutAt = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'user') {
      turnsSeen++;
      if (turnsSeen === maxTurns) {
        cutAt = i;
        // Keep walking only to confirm there exist older turns; the
        // moment we see another older user we know the slice will
        // actually drop something.
      } else if (turnsSeen > maxTurns) {
        // We've already recorded the right cutAt on the previous
        // iteration; stop scanning.
        break;
      }
    }
  }
  // If we never saw more than `maxTurns` user events, return as-is.
  if (cutAt <= 0) return events;
  if (turnsSeen <= maxTurns) return events;
  stats.truncatedToTailTurns = cutAt;
  return events.slice(cutAt);
};

const emitJsonlEvents = (events: IntermediateEvent[]): KiroJsonlEvent[] => {
  const out: KiroJsonlEvent[] = [];
  for (const ev of events) {
    if (ev.type === 'user') {
      out.push({
        version: 'v1',
        kind: 'Prompt',
        data: {
          message_id: randomUUID(),
          content: [{ kind: 'text', data: ev.text }],
          meta: { timestamp: ev.timestamp },
        },
      });
      continue;
    }
    if (ev.type === 'assistantText') {
      out.push({
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          message_id: randomUUID(),
          content: [{ kind: 'text', data: ev.text }],
        },
      });
      continue;
    }
    if (ev.type === 'assistantToolUse') {
      const content: KiroJsonContent[] = [];
      if (ev.inlineText && ev.inlineText.length > 0) {
        content.push({ kind: 'text', data: ev.inlineText });
      } else {
        content.push({ kind: 'text', data: '' });
      }
      for (const tu of ev.toolUses) {
        content.push({
          kind: 'toolUse',
          data: { toolUseId: tu.toolUseId, name: tu.name, input: tu.input },
        });
      }
      out.push({
        version: 'v1',
        kind: 'AssistantMessage',
        data: { message_id: randomUUID(), content },
      });
      continue;
    }
    if (ev.type === 'toolResult') {
      type ToolResultEvent = Extract<KiroJsonlEvent, { kind: 'ToolResults' }>;
      type ToolResultContent = ToolResultEvent['data']['content'];
      type ToolResultResults = ToolResultEvent['data']['results'];
      const content: ToolResultContent = [];
      const results: ToolResultResults = {};
      for (const r of ev.results) {
        content.push({
          kind: 'toolResult',
          data: {
            toolUseId: r.toolUseId,
            content: r.content,
            status: r.status,
          },
        });
        const items: Array<{ Text: string } | { Json: unknown }> = [];
        for (const c of r.content) {
          if (c.kind === 'text') items.push({ Text: typeof c.data === 'string' ? c.data : String(c.data) });
          else items.push({ Json: c.data });
        }
        results[r.toolUseId] = {
          tool: {
            tool_use_purpose: null,
            kind: { Mcp: { toolName: 'unknown', serverName: SYNTH_MCP_SERVER_NAME, params: {} } },
          },
          result: { Success: { items } },
        };
      }
      out.push({
        version: 'v1',
        kind: 'ToolResults',
        data: {
          message_id: randomUUID(),
          content,
          results,
        },
      });
      continue;
    }
  }
  return out;
};

export interface SynthesizeKiroSessionOptions {
  /** ACP session id to write the files under. */
  sessionId: string;
  /** Workspace cwd recorded into the metadata json. */
  cwd: string;
  /** Conversation history to materialise. SK ordering need not be enforced; this module sorts. */
  items: MessageItem[];
  /**
   * Override the home directory containing `.kiro/sessions/cli/`. Defaults
   * to `process.env.HOME`. Useful for tests.
   */
  home?: string;
  /**
   * Maximum number of turns to retain when invariant repair would yield
   * an empty event list. Defaults to {@link DEFAULT_MAX_TURNS_FALLBACK}.
   */
  maxTurnsFallback?: number;
  /**
   * Kiro model id to record in the v3 `session.json` metadata (e.g.
   * `claude-sonnet-4.5`). The v3 engine resolves the inference model from
   * the session store on `session/load` (verified empirically: rewriting
   * `modelId` in `session.json` and loading the session makes subsequent
   * `GenerateAssistantResponse` calls use the new model), so this is the
   * mechanism both for preserving the session's model across recovery
   * synthesis AND for the model-switch session rotation. Omit (or pass
   * `undefined`) for the server-side default ("auto") — v3 writes no
   * `modelId` key at all for auto sessions, so absence is the faithful
   * representation. Ignored by the v2 writer.
   */
  modelId?: string;
  /**
   * Injection point for materialising image S3 keys into local filesystem
   * paths. Defaults to the agent-core `materializeImageBlock` which fetches
   * from S3, resizes to ≤1568px, and writes a JPEG preview. Tests inject a
   * mock to avoid real S3 IO.
   */
  materializeImage?: MaterializeImageFn;
}

export interface SynthesizeKiroSessionResult {
  jsonPath: string;
  jsonlPath: string;
  events: KiroJsonlEvent[];
  stats: NormaliseStats;
}

const sortByteSafe = (items: MessageItem[]): MessageItem[] => {
  // SK is a fixed-width zero-padded numeric string in production, so
  // localeCompare is overkill but harmless. Keeping it explicit guards
  // against future variable-width SKs.
  return [...items].sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0));
};

/**
 * Convert a DDB MessageItem stream into a kiro-cli session file pair.
 * Returns the resulting jsonl events, the absolute paths of the two
 * files written, and statistics describing how the conversion repaired
 * the input. Throws only on filesystem errors (e.g. unwritable HOME);
 * conversion-side issues are surfaced in `result.stats` so the caller
 * can log them without aborting the turn.
 *
 * Empty input or input that normalises to zero events still produces an
 * empty .jsonl and a metadata .json — kiro-cli accepts that as a
 * "fresh, no history" session.
 */
/**
 * Whitelist of characters allowed in a kiro-cli sessionId. ACP session
 * IDs are kiro-cli-generated UUIDs in production
 * (`f330b026-0916-4e7c-be92-cd7853e36dad`), so an alphanumeric +
 * hyphen + underscore alphabet covers every legitimate value while
 * blocking path-traversal vectors before they ever reach
 * `path.join`. Defence in depth: the worker only ever passes
 * persisted sessionIds back here, but a future caller (or a corrupted
 * session row) must not be able to escape the
 * `~/.kiro/sessions/cli/` directory by smuggling `..` or `/` into
 * the synthesised file path.
 *
 * Exported so tests can pin the contract.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const assertValidSessionId = (sessionId: string): void => {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `synthesizeKiroSessionFiles: invalid sessionId (must match ${SESSION_ID_PATTERN}): ${JSON.stringify(sessionId)}`
    );
  }
};

/**
 * Atomically write `data` to `targetPath` by going through a process-
 * unique temp file in the same directory and `rename`-ing it into
 * place. This avoids two failure modes a naïve `writeFile` exposes:
 *
 *   1. A second worker (or a stale kiro-cli subprocess holding the
 *      previous file open for append) observing a half-written file
 *      mid-truncate.
 *   2. A truncate-then-write crash leaving an empty file behind that
 *      kiro-cli would later refuse to load.
 *
 * `rename` on POSIX file systems is atomic when the source and target
 * live on the same filesystem — which is always the case here because
 * the temp file is created in the same directory as the target.
 */
const atomicWriteFile = async (targetPath: string, data: string): Promise<void> => {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  // pid + base36 ms + random nonce. The nonce protects against the
  // legitimate case where two writes inside the same process complete
  // their `path.join` step within the same millisecond — without it,
  // both calls would race for the same temp filename and the second
  // rename would clobber the first writer's still-open fd.
  const tmpPath = path.join(dir, `${base}.tmp.${process.pid}.${Date.now().toString(36)}.${randomUUID().slice(0, 8)}`);
  try {
    await fs.promises.writeFile(tmpPath, data, 'utf8');
    await fs.promises.rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the temp file so a partial write doesn't
    // leak into the directory listing on the next `chat -l`.
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
};

export const synthesizeKiroSessionFiles = async (
  options: SynthesizeKiroSessionOptions
): Promise<SynthesizeKiroSessionResult> => {
  assertValidSessionId(options.sessionId);
  const home = options.home ?? process.env.HOME;
  if (!home) {
    throw new Error('synthesizeKiroSessionFiles: HOME is not set; cannot locate kiro-cli session dir');
  }
  const dir = path.join(home, '.kiro', 'sessions', 'cli');
  await fs.promises.mkdir(dir, { recursive: true });

  const stats = newStats();
  stats.inputCount = options.items.length;

  const sorted = sortByteSafe(options.items);
  let intermediate = await buildIntermediateEvents(sorted, options.materializeImage);
  intermediate = normaliseEvents(intermediate, stats);
  intermediate = trimToTailTurns(intermediate, options.maxTurnsFallback ?? DEFAULT_MAX_TURNS_FALLBACK, stats);

  const events = emitJsonlEvents(intermediate);
  stats.emittedCount = events.length;

  const jsonlPath = path.join(dir, `${options.sessionId}.jsonl`);
  const jsonPath = path.join(dir, `${options.sessionId}.json`);

  const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  await atomicWriteFile(jsonlPath, jsonl);

  // Title is the first user prompt's text trimmed to a single line so
  // kiro-cli can show a sensible label on `chat -l`. It is purely
  // cosmetic — kiro-cli does not validate it.
  const firstPrompt = events.find((e) => e.kind === 'Prompt');
  const title =
    firstPrompt?.kind === 'Prompt' && firstPrompt.data.content[0]?.data
      ? String(firstPrompt.data.content[0]!.data).split('\n')[0]!.slice(0, 200)
      : 'remote-swe synthesised session';
  const now = new Date().toISOString();
  const metadata = {
    session_id: options.sessionId,
    cwd: options.cwd,
    created_at: now,
    updated_at: now,
    title,
    session_state: { version: 'v1' as const },
  };
  await atomicWriteFile(jsonPath, JSON.stringify(metadata));

  return { jsonPath, jsonlPath, events, stats };
};

/* ------------------------------------------------------------------ */
/* v3 (KAS engine) session synthesis                                    */
/* ------------------------------------------------------------------ */

/**
 * The v3 agent engine persists sessions in a COMPLETELY different layout
 * than the v2 CLI store this module originally targeted:
 *
 *   $HOME/.kiro/sessions/<workspaceHash>/<sessionId>/session.json
 *   $HOME/.kiro/sessions/<workspaceHash>/<sessionId>/messages.jsonl
 *
 * where `workspaceHash` is the first 16 hex chars of sha256(cwd) — the
 * exact cwd string later passed as the `cwd` param of `session/load`
 * (verified empirically against kiro-cli 2.16).
 *
 * CRITICAL v3 behaviour difference: `session/load` of an UNKNOWN
 * sessionId does NOT fail. It silently creates a brand-new empty session
 * under that id and returns success. That means the v2-era recovery flow
 * ("load fails → synthesise from DDB → load again") never fires under
 * v3, and a recycled container silently loses all conversation memory.
 * The worker must therefore synthesise the v3 files BEFORE calling
 * `session/load` whenever they are missing locally (see
 * `ensureSessionStarted` in kiro-agent-loop.ts).
 *
 * messages.jsonl events are `{ id, timestamp, payload }` envelopes. The
 * payload types relevant to history replay (verified against a live v3
 * session store and confirmed loadable + recallable by experiment):
 *   { type: 'user',        content: string }
 *   { type: 'assistant',   content: string }
 *   { type: 'tool_call',   toolCallId, toolName, args, status, kind }
 *   { type: 'tool_result', toolCallId, content: string }
 * Orchestration-only event types (turn_start, session_metadata, ...) are
 * optional for load and intentionally not synthesised.
 */

export const kiroV3WorkspaceHash = (cwd: string): string => {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
};

export const kiroV3SessionDir = (sessionId: string, cwd: string, home?: string): string => {
  const h = home ?? process.env.HOME;
  if (!h) {
    throw new Error('kiroV3SessionDir: HOME is not set; cannot locate kiro-cli session dir');
  }
  return path.join(h, '.kiro', 'sessions', kiroV3WorkspaceHash(cwd), sessionId);
};

/**
 * Whether the v3 session store already contains this session for this
 * workspace. Used by the worker as the pre-`session/load` gate: when the
 * files are missing, v3's load would fabricate an empty session instead
 * of failing, so the caller must synthesise first.
 */
export const kiroV3SessionFilesExist = (sessionId: string, cwd: string, home?: string): boolean => {
  try {
    assertValidSessionId(sessionId);
    const dir = kiroV3SessionDir(sessionId, cwd, home);
    return fs.existsSync(path.join(dir, 'session.json')) && fs.existsSync(path.join(dir, 'messages.jsonl'));
  } catch {
    return false;
  }
};

interface KiroV3JsonlEvent {
  id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

const skToIsoTimestamp = (sk: string): string => {
  const ms = Number.parseInt(sk, 10);
  if (!Number.isFinite(ms) || ms <= 0) return new Date().toISOString();
  return new Date(ms).toISOString();
};

const stringifyResultContent = (content: Array<{ kind: 'text' | 'json'; data: unknown }>): string => {
  return content
    .map((c) => (c.kind === 'text' ? (typeof c.data === 'string' ? c.data : String(c.data)) : JSON.stringify(c.data)))
    .join('\n');
};

const emitV3JsonlEvents = (events: IntermediateEvent[]): KiroV3JsonlEvent[] => {
  const out: KiroV3JsonlEvent[] = [];
  for (const ev of events) {
    const timestamp = skToIsoTimestamp(ev.sk);
    if (ev.type === 'user') {
      out.push({ id: randomUUID(), timestamp, payload: { type: 'user', content: ev.text } });
      continue;
    }
    if (ev.type === 'assistantText') {
      out.push({ id: randomUUID(), timestamp, payload: { type: 'assistant', content: ev.text } });
      continue;
    }
    if (ev.type === 'assistantToolUse') {
      if (ev.inlineText && ev.inlineText.length > 0) {
        out.push({ id: randomUUID(), timestamp, payload: { type: 'assistant', content: ev.inlineText } });
      }
      for (const tu of ev.toolUses) {
        out.push({
          id: `${tu.toolUseId}-call`,
          timestamp,
          payload: {
            type: 'tool_call',
            toolCallId: tu.toolUseId,
            toolName: tu.name,
            args: tu.input ?? {},
            status: 'approved',
            kind: 'execute',
          },
        });
      }
      continue;
    }
    if (ev.type === 'toolResult') {
      for (const r of ev.results) {
        out.push({
          id: `${r.toolUseId}-result`,
          timestamp,
          payload: {
            type: 'tool_result',
            toolCallId: r.toolUseId,
            content: stringifyResultContent(r.content),
          },
        });
      }
      continue;
    }
  }
  return out;
};

export interface SynthesizeKiroSessionV3Result {
  sessionDir: string;
  jsonPath: string;
  jsonlPath: string;
  events: KiroV3JsonlEvent[];
  stats: NormaliseStats;
  /**
   * `createdAt` written into session.json. v3's `session/load` echoes the
   * stored metadata back in its result `_meta`, so the caller can compare
   * the two to detect the silent-fabrication mode (kiro-cli ignored the
   * synthesised files, e.g. after a store-schema bump).
   */
  createdAt: string;
}

/**
 * v3 counterpart of {@link synthesizeKiroSessionFiles}: materialise the
 * `session.json` + `messages.jsonl` pair in the v3 session store from
 * DDB history so a subsequent `session/load` replays real memory
 * instead of silently fabricating an empty session.
 *
 * Shares the entire normalisation pipeline (alternation repair, orphan
 * dropping, tail trimming) with the v2 writer; only the on-disk format
 * differs.
 */
export const synthesizeKiroSessionFilesV3 = async (
  options: SynthesizeKiroSessionOptions
): Promise<SynthesizeKiroSessionV3Result> => {
  assertValidSessionId(options.sessionId);
  const dir = kiroV3SessionDir(options.sessionId, options.cwd, options.home);
  await fs.promises.mkdir(dir, { recursive: true });

  const stats = newStats();
  stats.inputCount = options.items.length;

  const sorted = sortByteSafe(options.items);
  let intermediate = await buildIntermediateEvents(sorted, options.materializeImage);
  intermediate = normaliseEvents(intermediate, stats);
  intermediate = trimToTailTurns(intermediate, options.maxTurnsFallback ?? DEFAULT_MAX_TURNS_FALLBACK, stats);

  const events = emitV3JsonlEvents(intermediate);
  stats.emittedCount = events.length;

  const jsonlPath = path.join(dir, 'messages.jsonl');
  const jsonPath = path.join(dir, 'session.json');

  const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  await atomicWriteFile(jsonlPath, jsonl);

  const firstUser = intermediate.find((e) => e.type === 'user');
  const title =
    firstUser && firstUser.type === 'user' && firstUser.text.length > 0
      ? firstUser.text.split('\n')[0]!.slice(0, 200)
      : 'remote-swe synthesised session';
  const createdAt = events.length > 0 ? events[0]!.timestamp : new Date().toISOString();
  const metadata = {
    schemaVersion: '1.0.0',
    dataModelVersion: 1,
    id: options.sessionId,
    title,
    agentMode: 'vibe',
    workspacePaths: [options.cwd],
    createdAt,
    lastModifiedAt: new Date().toISOString(),
    // Omit `modelId` for auto (server default). NOTE: kiro-cli's OWN
    // session/new writes `"modelId": "auto"` explicitly (verified against
    // kiro-cli 2.18.0), so omission here is NOT byte-identical to kiro-cli's
    // shape — but a missing key and the literal "auto" both resolve to the
    // auto model, and readKiroV3SessionModelId normalises both to undefined.
    ...(options.modelId ? { modelId: options.modelId } : {}),
  };
  await atomicWriteFile(jsonPath, JSON.stringify(metadata, null, 2));

  return { sessionDir: dir, jsonPath, jsonlPath, events, stats, createdAt };
};

/**
 * Read the `modelId` recorded in a v3 session's on-disk `session.json`,
 * normalised so that "auto" is represented as `undefined`.
 *
 * Returns `undefined` when the file is missing, unparsable, carries no
 * `modelId` key, or records the literal `"auto"` — all mean "auto" (the
 * server default) from the caller's perspective. The `"auto"` normalisation
 * is important: kiro-cli's OWN `session/new` writes `"modelId": "auto"`
 * explicitly to session.json (verified empirically against kiro-cli 2.18.0
 * via the ACP probe), whereas remote-swe's synthesiser omits the key for
 * auto. Callers compare this against the desired model where auto is
 * `undefined`, so without collapsing `"auto"` → `undefined` an auto session
 * created by kiro-cli would be seen as different from the desired auto and
 * trigger a needless model-rotation on every turn.
 *
 * This is the authoritative source for the live session's model: the
 * `session/load` response `_meta` does NOT reliably echo `modelId`, but the
 * engine provably resolves the inference model from this file (see
 * {@link SynthesizeKiroSessionOptions.modelId}).
 */
export const readKiroV3SessionModelId = (sessionId: string, cwd: string, home?: string): string | undefined => {
  try {
    const jsonPath = path.join(kiroV3SessionDir(sessionId, cwd, home), 'session.json');
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { modelId?: unknown };
    if (typeof parsed.modelId !== 'string' || parsed.modelId.length === 0 || parsed.modelId === 'auto') {
      return undefined;
    }
    return parsed.modelId;
  } catch {
    return undefined;
  }
};

// Test-only exports. Kept on a separate symbol set so production callers
// can rely on `synthesizeKiroSessionFiles` as the single public entry
// point and the linter flags any accidental imports of internals.
export const __test = {
  parseContent,
  buildIntermediateEvents,
  normaliseEvents,
  trimToTailTurns,
  emitJsonlEvents,
  emitV3JsonlEvents,
  USER_ROLE_TYPES,
};
