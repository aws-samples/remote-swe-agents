/**
 * Isomorphic helpers for the `sendFileToUser` tool-result sentinel that
 * carries the canonical S3 key from backend to webapp renderer.
 *
 * This module is deliberately split out from `lib/images.ts` (and the
 * `./lib` barrel in general) so it can be imported from webapp *client*
 * components without dragging in Node-only transitive dependencies such
 * as the native `sharp`
 * binary (via `messages.ts`). The helpers here use only Web-standard
 * APIs (`btoa` / `atob` / `TextEncoder` / `TextDecoder`) so the same
 * bundled code runs in Node, the browser, and Edge runtimes without a
 * `Buffer` polyfill.
 *
 * The wire format MUST stay byte-compatible with the Node-side encoder
 * that shipped in the first cut of this PR — historical tool-result
 * rows produced with `Buffer.from(...).toString('base64url')` need to
 * keep parsing through `parseAttachmentSentinel`, and vice versa. Any
 * change to `ATTACHMENT_SENTINEL_TAG` or the base64url JSON envelope is
 * a breaking change for persisted conversation history.
 *
 * Why a sentinel at all? When `sendFileToUser` runs inside a kiro-cli
 * session the MCP server cannot see the ACP `toolCallId` kiro uses when
 * persisting the toolUse row, so the server falls back to `randomUUID()`
 * for `context.toolUseId` (see `mcp-server/server.ts`). The S3 key the
 * tool writes to — `${workerId}/${toolUseId}/${fileName}` — is therefore
 * not reconstructible from the persisted toolUse input alone. Embedding
 * the canonical key in the tool-result text and parsing it on the
 * renderer side sidesteps the id-mismatch without touching kiro-cli.
 *
 * LLM note: the marker is purely for webapp rendering — models should
 * ignore it. It is deliberately syntactically inert (an HTML comment
 * with a base64url payload, not natural language), so there is nothing
 * for the model to act on even if it is echoed back in conversation
 * history.
 */

const ATTACHMENT_SENTINEL_TAG = 'remote-swe-attachment';
const ATTACHMENT_SENTINEL_RE = new RegExp(`<!--${ATTACHMENT_SENTINEL_TAG}:([A-Za-z0-9_-]+)-->`);

export interface AttachmentSentinelPayload {
  key: string;
  isImage: boolean;
}

const utf8ToBase64Url = (s: string): string => {
  // TextEncoder yields a UTF-8 Uint8Array on every runtime; `btoa` wants
  // a binary string (one code unit per byte) so we hand-roll the
  // conversion instead of naïvely calling `btoa(s)`, which chokes on any
  // code point above 0xFF. The chunking keeps `String.fromCharCode.apply`
  // out of its argument-limit danger zone for very large payloads.
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const base64UrlToUtf8 = (s: string): string => {
  // Reverse of `utf8ToBase64Url`: base64url → base64 → binary string →
  // bytes → UTF-8 text. Padding is restored to a multiple of 4 before
  // `atob`; most standards-conformant implementations accept the
  // unpadded form but not all runtimes do, so we normalise defensively.
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

export const buildAttachmentSentinel = (payload: AttachmentSentinelPayload): string => {
  return `<!--${ATTACHMENT_SENTINEL_TAG}:${utf8ToBase64Url(JSON.stringify(payload))}-->`;
};

export const parseAttachmentSentinel = (text: string | undefined | null): AttachmentSentinelPayload | undefined => {
  if (!text) return undefined;
  const m = text.match(ATTACHMENT_SENTINEL_RE);
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(base64UrlToUtf8(m[1])) as Partial<AttachmentSentinelPayload>;
    if (typeof parsed.key !== 'string' || typeof parsed.isImage !== 'boolean') return undefined;
    return { key: parsed.key, isImage: parsed.isImage };
  } catch {
    return undefined;
  }
};
