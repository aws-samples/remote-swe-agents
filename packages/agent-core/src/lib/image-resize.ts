import sharp from 'sharp';

/**
 * Claude API many-image constraint: when a conversation contains multiple images,
 * each image must have both dimensions ≤ 2000px. We use 1568px (Claude's recommended
 * optimal resolution) as the cap to stay well within the limit.
 */
export const MAX_IMAGE_DIMENSION = 1568;

export interface EnsureImageWithinBoundsOptions {
  format?: string;
  mimeType?: string;
}

/**
 * Downscale an image buffer so that neither dimension exceeds MAX_IMAGE_DIMENSION.
 * Returns the original buffer unchanged if already within bounds or if dimensions
 * cannot be determined (unknown format). Throws if the image is confirmed oversized
 * but resize fails — preventing silent re-submission of an oversized payload that
 * would trigger a permanent 400.
 *
 * @param imageBuffer Raw image bytes
 * @param opts.format Bedrock-style format (e.g. 'png', 'jpeg', 'webp')
 * @param opts.mimeType MIME type (e.g. 'image/png', 'image/jpeg')
 */
export const ensureImageWithinBounds = async (
  imageBuffer: Uint8Array,
  opts: EnsureImageWithinBoundsOptions = {}
): Promise<Uint8Array> => {
  let width: number | undefined;
  let height: number | undefined;
  try {
    const metadata = await sharp(imageBuffer).metadata();
    width = metadata.width;
    height = metadata.height;
  } catch {
    return imageBuffer;
  }
  if (!width || !height || (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION)) {
    return imageBuffer;
  }
  // Image is confirmed oversized — resize MUST succeed or we throw
  // (caller replaces with text placeholder rather than sending oversized data).
  const outputFormat = resolveSharpFormat(opts);
  const pipeline = sharp(imageBuffer).resize({
    width: MAX_IMAGE_DIMENSION,
    height: MAX_IMAGE_DIMENSION,
    fit: 'inside',
  });
  if (outputFormat) {
    pipeline.toFormat(outputFormat, { quality: 85 });
  }
  const resized = await pipeline.toBuffer();
  return new Uint8Array(resized);
};

const MIME_TO_FORMAT: Record<string, keyof sharp.FormatEnum> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const resolveSharpFormat = (opts: EnsureImageWithinBoundsOptions): keyof sharp.FormatEnum | undefined => {
  if (opts.mimeType) {
    return MIME_TO_FORMAT[opts.mimeType];
  }
  if (opts.format) {
    const f = opts.format === 'jpg' ? 'jpeg' : opts.format;
    if (['png', 'jpeg', 'gif', 'webp'].includes(f)) {
      return f as keyof sharp.FormatEnum;
    }
  }
  return undefined;
};
