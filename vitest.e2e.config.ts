import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@rnr/core': r('./packages/core/src/index.ts'),
      '@rnr/data': r('./packages/data/src/index.ts'),
    },
    // @rnr/data imports 'server-only', whose default export THROWS by design so
    // that a client component importing it fails loudly. Plain Node trips the
    // same guard, so the react-server condition (which resolves the package to an
    // empty module) has to be declared here too. The guard stays in place for the
    // browser bundle, which is the only place it should ever fire.
    conditions: ['react-server', 'node', 'import', 'default'],
  },
  test: {
    include: ['packages/**/*.e2e.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    /**
     * ==================== THE E2E SUITE CAN NEVER GO LIVE ====================
     * `import 'dotenv/config'` above loads the real .env, and the moment
     * LIVE_CALLS_ENABLED was flipped to 'true' for the voice work, `pnpm e2e`
     * silently became a suite that spends money: live DataForSEO SERP purchases and
     * live Twilio SMS to a real phone.
     *
     * The `spend === 0` assertion does not protect against that -- it fires AFTER the
     * requests, so it reports the loss rather than preventing it.
     *
     * Forced here rather than in each test file, because the danger is ambient
     * configuration and the fix has to be too: a new e2e file must be safe by
     * default, without its author remembering this.
     * ========================================================================
     */
    env: { LIVE_CALLS_ENABLED: 'false' },
    // A full 40-niche fixture scan plus schema setup. Sequential: the suite
    // owns the test schema.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
})
