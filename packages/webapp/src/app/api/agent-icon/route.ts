import { NextRequest, NextResponse } from 'next/server';
import { getPreferences } from '@remote-swe-agents/agent-core/lib';
import { getBytesFromKey, getHeadFromKey } from '@remote-swe-agents/agent-core/aws';
import sharp from 'sharp';
import { getPresetIcon, isPresetIconKey, presetIconSvg } from '@/lib/agent-icon-presets';

export const dynamic = 'force-dynamic';

function etagMatch(ifNoneMatch: string, etag: string): boolean {
  const normalized = etag.replace(/^W\//, '');
  return ifNoneMatch.split(',').some((t) => t.trim().replace(/^W\//, '') === normalized);
}

export async function GET(request: NextRequest) {
  try {
    const keyParam = request.nextUrl.searchParams.get('key');
    let iconKey: string | undefined;

    if (keyParam) {
      iconKey = keyParam;
    } else {
      const preferences = await getPreferences();
      iconKey = preferences.defaultAgentIconKey;
    }

    if (!iconKey) {
      return NextResponse.redirect(new URL('/icon-192x192.png', request.url));
    }

    if (isPresetIconKey(iconKey)) {
      const preset = getPresetIcon(iconKey);
      if (!preset) {
        return NextResponse.redirect(new URL('/icon-192x192.png', request.url));
      }
      const presetSizeParam = request.nextUrl.searchParams.get('size');
      const parsedPresetSize = presetSizeParam ? parseInt(presetSizeParam, 10) : NaN;
      const presetSize =
        Number.isFinite(parsedPresetSize) && parsedPresetSize > 0 && parsedPresetSize <= 1024 ? parsedPresetSize : 192;
      const svg = presetIconSvg(preset, presetSize);
      const presetEtag = `"preset-${preset.id}-s${presetSize}"`;
      const presetIfNoneMatch = request.headers.get('if-none-match');
      if (presetIfNoneMatch && etagMatch(presetIfNoneMatch, presetEtag)) {
        return new NextResponse(null, {
          status: 304,
          headers: {
            ETag: presetEtag,
            'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400',
          },
        });
      }
      return new NextResponse(svg, {
        headers: {
          'Content-Type': 'image/svg+xml',
          ETag: presetEtag,
          'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400',
        },
      });
    }

    const sizeParam = request.nextUrl.searchParams.get('size');
    const size = sizeParam ? parseInt(sizeParam, 10) : undefined;

    const ifNoneMatch = request.headers.get('if-none-match');

    const head = await getHeadFromKey(iconKey);
    const etag = head.ETag ?? undefined;
    const sizeQualifiedEtag = etag ? (size ? `"${etag.replace(/"/g, '')}-s${size}"` : etag) : undefined;

    if (ifNoneMatch && sizeQualifiedEtag && etagMatch(ifNoneMatch, sizeQualifiedEtag)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: sizeQualifiedEtag,
          'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400',
        },
      });
    }

    const bytes = await getBytesFromKey(iconKey);
    let outputBuffer: Buffer;

    if (size && size > 0 && size <= 1024) {
      outputBuffer = await sharp(Buffer.from(bytes)).resize(size, size, { fit: 'cover' }).png().toBuffer();
    } else {
      outputBuffer = Buffer.from(bytes);
    }

    const responseHeaders: Record<string, string> = {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400',
    };
    if (sizeQualifiedEtag) {
      responseHeaders['ETag'] = sizeQualifiedEtag;
    }

    return new NextResponse(new Uint8Array(outputBuffer), {
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Failed to serve agent icon:', error);
    return NextResponse.redirect(new URL('/icon-192x192.png', request.url));
  }
}
