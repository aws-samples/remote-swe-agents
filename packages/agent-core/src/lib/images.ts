import { basename, extname } from 'path';

// Re-export the isomorphic attachment-sentinel helpers so server-side
// callers that import from the `./lib` barrel keep working unchanged.
// The helpers themselves live in `../attachments` (reachable via the
// `./attachments` package export) because the webapp client bundle
// cannot import the `./lib` barrel — its other members transitively
// pull in Node-only deps (`child_process`, `sharp`).
export { buildAttachmentSentinel, parseAttachmentSentinel, type AttachmentSentinelPayload } from '../attachments';

export const getAttachedImageKey = (workerId: string, toolUseId: string, filePath: string) => {
  const ext = extname(filePath);
  return `${workerId}/${toolUseId}${ext}`;
};

export const getAttachedFileKey = (workerId: string, toolUseId: string, filePath: string) => {
  const fileName = basename(filePath);
  return `${workerId}/${toolUseId}/${fileName}`;
};

export const isImageKey = (key: string): boolean => {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif'];
  return imageExtensions.some((ext) => key.toLowerCase().endsWith(ext));
};

/**
 * Supported Bedrock Image `format` values. Mirrors the set the
 * `@aws-sdk/client-bedrock-runtime` `ImageFormat` enum advertises AND the
 * MIME types kiro-cli / Claude accepts on ACP `ContentBlock::Image`. SVG is
 * intentionally excluded — neither Bedrock nor Claude image input accepts
 * `image/svg+xml`, so a webapp drop of an SVG asset has to be rejected at
 * the content-type layer upstream (see `imageContentTypes` in the upload
 * presigner), not rescued here.
 */
export const SUPPORTED_IMAGE_FORMATS = ['png', 'jpeg', 'gif', 'webp'] as const;
export type SupportedImageFormat = (typeof SUPPORTED_IMAGE_FORMATS)[number];

/**
 * Derive the Bedrock-compatible image format from an S3 key. The webapp
 * upload presigner sets the key's extension from the HTTP `Content-Type`
 * (`contentType.split('/')[1]` in actions/upload/action.ts), so the
 * extension is an authoritative signal of the object's actual bytes.
 *
 * Returns `undefined` for unknown / missing extensions so callers can
 * decide whether to default to a safe value or reject the image. Do not
 * default to `'webp'` (the pre-2026-04-20 behaviour): DDB rows persisted
 * with an incorrect format caused kiro-cli `session/prompt` to raise
 * `ValidationException` on history replay because the base64 bytes (real
 * PNG) did not match the advertised `image/webp` MIME type.
 *
 * Examples:
 *   "worker-1/abc123.png"      -> "png"
 *   "worker-1/abc123.jpeg"     -> "jpeg"
 *   "worker-1/abc123.jpg"      -> "jpeg"    (aliased)
 *   "worker-1/abc123"          -> undefined
 *   "worker-1/abc123.svg"      -> undefined (unsupported by Bedrock)
 */
export const imageFormatFromKey = (key: string): SupportedImageFormat | undefined => {
  const ext = extname(key).toLowerCase().replace(/^\./, '');
  if (!ext) return undefined;
  if (ext === 'jpg') return 'jpeg';
  return (SUPPORTED_IMAGE_FORMATS as readonly string[]).includes(ext) ? (ext as SupportedImageFormat) : undefined;
};
