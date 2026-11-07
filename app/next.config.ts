import type { NextConfig } from 'next';

/**
 * Static export only. There is no server in this product: no API routes, no
 * server actions, no middleware, no image optimizer. If a change requires any
 * of those, it does not belong in v1 (PLAN.md §1).
 */
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const basePath = rawBasePath === '/' ? '' : rawBasePath;

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  typedRoutes: true,
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  // Static generation loads catalogue shards per page; unbounded workers each
  // hold large shard copies and exhaust the native zlib allocator (Z_MEM_ERROR).
  //
  // `scripts/build-app.mjs` sets this alongside the per-worker heap ceiling,
  // because it is their *product* that has to fit in the machine: NODE_OPTIONS
  // is inherited by every worker, so four workers at 6 GB ask for 24 GB and
  // make the OOM more likely, not less.
  experimental: { cpus: Number(process.env.NEXT_BUILD_WORKERS ?? 2) },
};

export default nextConfig;
