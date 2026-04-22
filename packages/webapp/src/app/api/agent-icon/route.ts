import { NextRequest, NextResponse } from 'next/server';
import { getPreferences } from '@remote-swe-agents/agent-core/lib';
import { getBytesFromKey } from '@remote-swe-agents/agent-core/aws';
import sharp from 'sharp';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // Support explicit key parameter for custom agent icons
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

    const sizeParam = request.nextUrl.searchParams.get('size');
    const size = sizeParam ? parseInt(sizeParam, 10) : undefined;

    const bytes = await getBytesFromKey(iconKey);
    let outputBuffer: Buffer;

    if (size && size > 0 && size <= 1024) {
      outputBuffer = await sharp(Buffer.from(bytes)).resize(size, size, { fit: 'cover' }).png().toBuffer();
    } else {
      outputBuffer = Buffer.from(bytes);
    }

    return new NextResponse(new Uint8Array(outputBuffer), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
      },
    });
  } catch (error) {
    console.error('Failed to serve agent icon:', error);
    return NextResponse.redirect(new URL('/icon-192x192.png', request.url));
  }
}
