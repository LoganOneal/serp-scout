import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@rnr/core': r('./packages/core/src/index.ts'),
      '@rnr/data': r('./packages/data/src/index.ts'),
      '@rnr/supply-feed': r('./packages/supply-feed/src/index.ts'),
    },
    // See the note in vitest.e2e.config.ts: 'server-only' throws under plain
    // Node, so the react-server condition resolves it to an empty module. The
    // guard still fires where it matters -- a browser bundle.
    conditions: ['react-server', 'node', 'import', 'default'],
  },
  test: {
    /**
     * Same reasoning as vitest.e2e.config.ts: no test suite may inherit a live
     * LIVE_CALLS_ENABLED from .env. The unit suite makes no network calls today, but
     * a future test that constructs providers must be safe without its author
     * knowing this file exists.
     */
    env: { LIVE_CALLS_ENABLED: 'false' },
    // Unit + contract tests only. These must never touch the network or a
    // database, so the e2e suite (which needs real Postgres) lives in its own
    // config rather than behind a skip-if-env guard -- a skipped test that
    // silently never runs is the same failure mode as an unmeasured signal.
    include: ['packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
    environment: 'node',
  },
})
