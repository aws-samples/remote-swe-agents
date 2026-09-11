import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import path from 'path';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // Native/server-only packages used by the skill zip handling; keep them out
  // of the client/edge bundle so Next does not try to bundle native binaries.
  serverExternalPackages: ['@node-rs/crc32', 'yauzl-promise'],
  experimental: {
    webpackBuildWorker: true,
    parallelServerBuildTraces: true,
    parallelServerCompiles: true,
    serverActions: {
      allowedOrigins: ['localhost:3011', process.env.ALLOWED_ORIGIN_HOST].filter(
        (origin): origin is string => !!origin
      ),
    },
  },
  typescript: {
    ignoreBuildErrors: process.env.SKIP_TS_BUILD == 'true',
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
