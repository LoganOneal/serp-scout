import { defineConfig } from '@trigger.dev/sdk/v3'
import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'

/**
 * The Trigger CLI looks for `.env` next to this config (apps/web), but the
 * monorepo keeps one at the ROOT so the web app, the worker, and the CLI
 * scripts cannot drift. Same load as next.config.ts, for the same reason:
 * without it `dev` runs boot with no DATABASE_URL and db() throws.
 *
 * Deployed runs do NOT read this file's env — set those in the Trigger
 * dashboard (see docs/trigger-dev-setup.md).
 */
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

/**
 * Trigger.dev config for the Next.js app (discovery long-runner).
 *
 * Project: RankAndRent Patform — proj_eiqklproulshogglvxmb
 *
 * @rnr/data uses the `server-only` package (Next guard). The worker is Node, not
 * a Client Component — we shim `server-only` to an empty module at build time.
 */
export default defineConfig({
  project: 'proj_eiqklproulshogglvxmb',
  runtime: 'node',
  logLevel: 'log',
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10_000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ['./src/trigger'],
  build: {
    // Workspace packages + heavy native-ish deps: resolve from monorepo.
    external: ['postgres'],
    extensions: [
      {
        name: 'server-only-shim',
        onBuildStart: async (context) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          context.registerPlugin({
            name: 'server-only-shim',
            setup(build: {
              onResolve: (
                opts: { filter: RegExp },
                cb: (args: { path: string }) => { path: string; namespace: string } | undefined,
              ) => void
              onLoad: (
                opts: { filter: RegExp; namespace: string },
                cb: () => { contents: string; loader: string },
              ) => void
            }) {
              build.onResolve({ filter: /^server-only$/ }, () => ({
                path: 'server-only',
                namespace: 'soa-shim',
              }))
              build.onLoad({ filter: /.*/, namespace: 'soa-shim' }, () => ({
                contents: 'export {};',
                loader: 'js',
              }))
            },
          } as never)
        },
      },
    ],
  },
})
