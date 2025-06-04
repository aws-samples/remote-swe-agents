import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const nextConfig: NextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    webpackBuildWorker: true,
    parallelServerBuildTraces: true,
    parallelServerCompiles: true,
    serverActions: {
      allowedOrigins: ['localhost:3011', process.env.ALLOWED_ORIGIN_HOST!],
    },
  },
  typescript: {
    ignoreBuildErrors: process.env.SKIP_TS_BUILD == 'true',
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
