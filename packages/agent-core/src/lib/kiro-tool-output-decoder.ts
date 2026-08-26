/**
 * kiro-cli tool-output "dialect" decoder (v2 + v3).
 *
 * kiro-cli does NOT populate the ACP-spec `content[]` array for
 * `tool_call_update`; it puts the tool result under a `rawOutput` object whose
 * shape depends on the agent engine:
 *
 *   v2 (legacy ACP engine): a Rust externally-tagged enum list
 *     rawOutput = { items: [ { Text: "..." } | { Json: <value> } ] }
 *     where `Json` for execute_bash is { exit_status, stdout, stderr } and for
 *     MCP tools is the wrapped MCP `result` object ({ content: [...] , isError }).
 *
 *   v3 (KAS engine): a flat object
 *     rawOutput = { output: string, exitCode: number, message: string }
 *     (`output` = combined stdout+stderr, `message` = the human-readable block
 *     kiro-cli renders, e.g. "Output:\n...\n\nExit Code: 0").
 *
 * This module is engine-agnostic: {@link decodeKiroToolOutput} tries the v3
 * flat shape first, then falls back to the v2 `items[]`/legacy-flat handling,
 * so a single call site works across engines and tolerates unknown variants
 * (never silently drops a non-empty payload).
 *
 * Ported from the inline extractor in the former hand-written kiro ACP client
 * (v2 paths preserved verbatim) plus a new v3 branch. Standalone + unit-tested
 * and consumed by the Strands `KiroAcpAgent` (see
 * `worker/src/agent/strands/kiro-acp-agent.ts`), which replaced the
 * hand-written client.
 */

/**
 * Decode a kiro-cli `tool_call_update.rawOutput` (any engine) into a display
 * string, or `undefined` when there is nothing extractable.
 *
 * Return contract (matches the legacy extractor so call sites are unchanged):
 *  - `string` (possibly `""`): a valid extraction; `""` means the tool
 *    intentionally produced no content (successful no-output bash / MCP void).
 *  - `undefined`: nothing extractable (e.g. `rawOutput` absent or empty `{}`).
 */
export function decodeKiroToolOutput(rawOutput: unknown): string | undefined {
  if (rawOutput === undefined || rawOutput === null) return undefined;
  if (typeof rawOutput === 'string') return rawOutput;
  if (typeof rawOutput !== 'object') return undefined;

  const obj = rawOutput as Record<string, unknown>;

  // v3 (KAS engine) flat shape: { output, exitCode, message }.
  // Detected by the presence of the v3-specific keys; handled before the v2
  // `items[]` path (v3 never emits `items`).
  if (isV3RawOutput(obj)) {
    return renderV3RawOutput(obj);
  }

  // v2 `items[]` + legacy flat shapes.
  return extractFromRawOutputV2(obj);
}

/**
 * A v3 rawOutput carries `output` (string) and/or `exitCode` (number) and/or a
 * `message` (string), and crucially has NO `items` array (which is the v2
 * discriminator). We treat the object as v3 when it has any of the v3 keys and
 * is not a v2 `items[]` wrapper.
 */
function isV3RawOutput(obj: Record<string, unknown>): boolean {
  if (Array.isArray(obj.items)) return false;
  const hasOutput = typeof obj.output === 'string';
  const hasExitCode = typeof obj.exitCode === 'number';
  const hasMessage = typeof obj.message === 'string';
  return hasOutput || hasExitCode || hasMessage;
}

/**
 * Render the v3 flat shape. Prefer `output` (raw combined stdout+stderr);
 * fall back to `message` (the pre-rendered human block) when `output` is
 * absent. Append a non-zero exit code marker, mirroring how the v2 path
 * surfaces a non-"exit status: 0". An empty `output` with exitCode 0 yields
 * `""` (intentional empty), consistent with the v2 contract.
 */
function renderV3RawOutput(obj: Record<string, unknown>): string | undefined {
  const output = typeof obj.output === 'string' ? obj.output : undefined;
  const message = typeof obj.message === 'string' ? obj.message : undefined;
  const exitCode = typeof obj.exitCode === 'number' ? obj.exitCode : undefined;

  // Choose the body: `output` is the raw tool output; `message` is kiro-cli's
  // rendered block. Prefer the raw output; if it is undefined use `message`.
  let body: string | undefined = output ?? message;

  if (body === undefined) {
    // Neither output nor message but exitCode present (e.g. a bare exit).
    if (exitCode !== undefined) return exitCode === 0 ? '' : `[exit code: ${exitCode}]`;
    return undefined;
  }

  // Only append the exit-code marker when we used `output` (the `message`
  // block already embeds "Exit Code: N"), and only for non-zero.
  if (output !== undefined && exitCode !== undefined && exitCode !== 0) {
    body = body.length > 0 ? `${body}\n[exit code: ${exitCode}]` : `[exit code: ${exitCode}]`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// v2 paths — ported verbatim from the former hand-written kiro ACP client (behaviour preserved).
// ---------------------------------------------------------------------------

function extractFromRawOutputV2(rawOutput: Record<string, unknown>): string | undefined {
  const items = rawOutput.items;
  if (Array.isArray(items)) {
    if (items.length === 0) return undefined;
    const parts: string[] = [];
    let sawAny = false;
    for (const item of items) {
      const rendered = renderRawOutputItem(item);
      if (rendered === undefined) continue;
      sawAny = true;
      if (rendered.length > 0) parts.push(rendered);
    }
    if (parts.length > 0) return parts.join('\n');
    if (sawAny) return '';
    return undefined;
  }

  if (hasRecognisedFlatKey(rawOutput)) {
    const direct = renderRawOutputItem(rawOutput);
    if (direct !== undefined && direct.length > 0) return direct;
  }

  return undefined;
}

const RECOGNISED_FLAT_KEYS = ['Text', 'text', 'Json', 'json'] as const;
const hasRecognisedFlatKey = (obj: Record<string, unknown>): boolean =>
  RECOGNISED_FLAT_KEYS.some((k) => obj[k] !== undefined);

function renderRawOutputItem(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return undefined;
  const obj = item as Record<string, unknown>;

  if (typeof obj.Text === 'string') return obj.Text;
  if (typeof obj.text === 'string') return obj.text;

  if (obj.Json !== undefined) {
    return stringifyJsonItem(obj.Json);
  }
  if (obj.json !== undefined) {
    return stringifyJsonItem(obj.json);
  }

  try {
    return JSON.stringify(obj);
  } catch {
    return undefined;
  }
}

function stringifyJsonItem(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  const v = value as Record<string, unknown>;

  // (1) execute_bash shape
  const stdout = typeof v.stdout === 'string' ? v.stdout : undefined;
  const stderr = typeof v.stderr === 'string' ? v.stderr : undefined;
  const exitStatus = typeof v.exit_status === 'string' ? v.exit_status : undefined;
  if (stdout !== undefined || stderr !== undefined || exitStatus !== undefined) {
    const parts: string[] = [];
    if (stdout && stdout.length > 0) parts.push(stdout);
    if (stderr && stderr.length > 0) parts.push(stderr);
    if (exitStatus && !/^exit status: 0$/i.test(exitStatus)) {
      parts.push(`[${exitStatus}]`);
    }
    const joined = parts.join('\n');
    if (joined.length > 0) return joined;
    return '';
  }

  // (2) MCP tool shape — the wrapped MCP `result.content[]` array.
  if (Array.isArray(v.content)) {
    const parts: string[] = [];
    let sawAnyEntry = false;
    for (const entry of v.content) {
      if (!entry || typeof entry !== 'object') continue;
      sawAnyEntry = true;
      const e = entry as Record<string, unknown>;
      const etype = typeof e.type === 'string' ? (e.type as string) : undefined;
      if (typeof e.text === 'string' && e.text.length > 0) {
        parts.push(e.text);
      } else if (etype === 'image') {
        const mime = typeof e.mimeType === 'string' ? (e.mimeType as string) : 'unknown';
        parts.push(`[image content (${mime})]`);
      } else if (etype === 'resource' || etype === 'resource_link') {
        const r = (
          e.resource && typeof e.resource === 'object' ? (e.resource as Record<string, unknown>) : e
        ) as Record<string, unknown>;
        const uri = typeof r.uri === 'string' ? (r.uri as string) : 'unknown';
        const mime = typeof r.mimeType === 'string' ? ` (${r.mimeType})` : '';
        const inlineText = typeof r.text === 'string' ? (r.text as string) : undefined;
        if (inlineText && inlineText.length > 0) {
          parts.push(inlineText);
        } else {
          parts.push(`[resource: ${uri}${mime}]`);
        }
      } else {
        try {
          parts.push(JSON.stringify(e));
        } catch {
          parts.push(String(e));
        }
      }
    }
    if (v.isError === true) {
      parts.push('[MCP tool reported isError=true]');
    }
    if (parts.length > 0) return parts.join('\n');
    if (sawAnyEntry === false) return '';
  }

  // (3) Unknown JSON — serialise so structured data survives.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
