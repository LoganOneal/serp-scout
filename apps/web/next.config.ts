import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants'
import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'

// Next reads .env from the APP directory, but this is a monorepo and the single
// source of truth lives at the root -- alongside the worker and the CLI scripts,
// which must not drift from what the web app sees. Loaded here because
// next.config runs in the same process as the server, so process.env is
// populated before any server component asks for DATABASE_URL.
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

export function resolveNextDistDir(
  phase: string,
  env: Readonly<Record<string, string | undefined>> = process.env as Readonly<
    Record<string, string | undefined>
  >,
): string | undefined {
  const override = env['NEXT_DIST_DIR']?.trim()
  if (override) return override
  return phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : undefined
}

const config = (phase: string): NextConfig => ({
  /**
   * Dev always lives outside `.next`; builds may be overridden when asked.
   *
   * ==================== WHY THIS EXISTS ====================
   * `next dev` and `next build` share `.next`, so running a build while the dev server is
   * up rewrites the manifests underneath it. That does not fail cleanly -- the dev server
   * starts throwing SegmentViewNode errors and dies, which reads as "the app broke" rather
   * than "two processes fought over a directory". It cost an hour here once.
   *
   *   next dev                                -> .next-dev
   *   next build                              -> .next
   *   NEXT_DIST_DIR=.next-build pnpm build   -> .next-build
   *
   * This makes the safe path the default instead of relying on every build
   * caller to remember an environment variable. Vercel and `next start` keep
   * the production `.next` default.
   * =======================================================
   */
  ...(resolveNextDistDir(phase) ? { distDir: resolveNextDistDir(phase) } : {}),

  /**
   * Trace from the WORKSPACE ROOT, not from apps/web.
   *
   * ==================== WHY A PAGE CAN HANG WITHOUT THIS ====================
   * Next decides which files each serverless function needs by tracing imports, and it
   * guesses the root. In a pnpm workspace that guess is apps/web, so files reached through
   * the root `node_modules/.pnpm` store and the sibling workspace packages can be left out
   * of the bundle.
   *
   * The failure is not a clean "module not found": on Vercel these pages returned ZERO
   * bytes and were killed at the 300-second limit, while route handlers and a page with no
   * client components answered normally. The same build served correctly under
   * `next start` locally, because there the missing files were still on disk.
   * ========================================================================
   */
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),

  // The workspace packages ship TypeScript source with no build step, so Next
  // must transpile them. @rnr/core is pure and importable from client
  // components; @rnr/data imports 'server-only' and will fail the build loudly
  // if a client component ever reaches for it.
  transpilePackages: ['@rnr/core', '@rnr/data'],
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
  },
  // The workspace packages import with explicit `.js` extensions, which is
  // correct for Node ESM and required by tsx and the worker. Webpack does not
  // apply the TypeScript `.js` -> `.ts` mapping to transpiled packages on its
  // own, so it has to be told.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
})

export default config
