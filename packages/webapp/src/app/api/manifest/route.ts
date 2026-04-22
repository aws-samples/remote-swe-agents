import { NextResponse } from 'next/server';
import { getPreferences } from '@remote-swe-agents/agent-core/lib';

export const dynamic = 'force-dynamic';

export async function GET() {
  const preferences = await getPreferences();
  const hasCustomIcon = !!preferences.defaultAgentIconKey;

  const manifest = {
    name: 'Remote SWE Agents',
    short_name: 'Remote SWE',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#3b82f6',
    icons: hasCustomIcon
      ? [
          {
            src: '/api/agent-icon?size=192',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/api/agent-icon?size=512',
            sizes: '512x512',
            type: 'image/png',
          },
        ]
      : [
          {
            src: '/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
  };

  return NextResponse.json(manifest, {
    headers: {
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
