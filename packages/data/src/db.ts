import 'server-only'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

/**
 * Database handle.
 *
 * `import 'server-only'` at the top is load-bearing: it makes a client component
 * that reaches for anything in this package fail AT BUILD TIME with a clear
 * message. Without it, the import typechecks cleanly, bundles the Postgres
 * driver into the browser, and fails at build with something unrelated-looking.
 */

export type Database = ReturnType<typeof drizzle<typeof schema>>

let cached: { db: Database; sql: postgres.Sql } | null = null

export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env['DATABASE_URL']
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and point it at your Postgres.',
    )
  }
  return url
}

/**
 * Migrations need a SESSION connection; the app wants a TRANSACTION one.
 *
 * `drizzle-kit push` issues DDL and advisory locks that do not survive a
 * transaction-mode pooler, so it reads this instead. Falls back to DATABASE_URL, which is
 * correct for a local Postgres where there is no pooler at all.
 */
export function getDirectDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env['DIRECT_DATABASE_URL']?.trim() || getDatabaseUrl(env)
}

/**
 * How many connections this process may hold.
 *
 * ==================== NEVER 1. A PAGE ISSUES CONCURRENT QUERIES ====================
 * This function first shipped returning 1 on Vercel, reasoning that a serverless instance
 * serves one request at a time so a pool is waste. That reasoning is wrong twice over: a
 * single render issues several queries at once (`/markets` does `Promise.all` over three),
 * and an instance may handle concurrent requests anyway.
 *
 * The failure was not a clean pool-timeout error. Against Supabase's transaction pooler,
 * concurrent queries on a max-1 pool never completed: every database-backed page returned
 * ZERO bytes and was killed at the 300-second limit, while route handlers -- which happened
 * to query sequentially -- answered in 300ms. Diagnosing that cost far more than the
 * connections it was trying to save. The mechanism inside the pooler is not something this
 * comment will claim to know; what is established is that 1 hangs and 4 does not.
 *
 * So: a small pool everywhere. Four is enough for the widest page and cheap enough that
 * many instances do not threaten the pooler, which exists to multiplex exactly this.
 * ================================================================================
 */
export const DEFAULT_POOL_MAX = 4

export function poolMax(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env['DATABASE_POOL_MAX'])
  // A configured 1 is refused rather than honoured. It is not a tuning choice, it is the
  // outage above, and it would arrive as "the site is down" with no error anywhere.
  if (Number.isInteger(configured) && configured > 1) return configured
  return DEFAULT_POOL_MAX
}

/**
 * Warn when the app is pointed at Supabase's SESSION pooler in a serverless runtime.
 *
 * Port 5432 on `*.pooler.supabase.com` holds one server connection per client for the
 * client's whole lifetime, and caps the project at ~15. It WORKS -- until traffic arrives,
 * at which point it fails as scattered 500s rather than as a configuration error. Port 6543
 * is the transaction pooler and is what serverless wants.
 *
 * A warning rather than a throw: someone may have a deliberate reason, and refusing to boot
 * over a port number would be the wrong trade for a business phone line.
 */
export function poolerWarning(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!env['VERCEL']) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!parsed.hostname.includes('pooler.supabase.com')) return null
  if (parsed.port !== '5432') return null
  return (
    'DATABASE_URL points at Supabase port 5432 (the SESSION pooler) from a serverless ' +
    'runtime. Use port 6543 (the transaction pooler) for the app and keep 5432 in ' +
    'DIRECT_DATABASE_URL for migrations, or expect connection exhaustion under load.'
  )
}

export function createDb(
  url: string,
  opts: { searchPath?: string; env?: NodeJS.ProcessEnv } = {},
): { db: Database; sql: postgres.Sql } {
  const env = opts.env ?? process.env

  const warning = poolerWarning(url, env)
  if (warning !== null) console.warn(`[db] ${warning}`)

  const sql = postgres(url, {
    max: poolMax(env),
    idle_timeout: 20,
    /**
     * ==================== A HANG IS THE WORST FAILURE, SO FORBID IT ====================
     * postgres.js waits FOREVER for a connection by default. When production could not get
     * connections, every page returned zero bytes and was killed at 300 seconds with no
     * error anywhere -- not in the logs, not on screen. It took hours to find, because a
     * hang is the one failure that produces no evidence.
     *
     * Ten seconds converts that into a real error, which the pages already handle: each
     * query on `/markets` is `.catch()`-wrapped, so a refused connection renders em dashes
     * and a diagnosable message instead of a browser spinning until the platform gives up.
     * Slower than a hang to nobody, and infinitely easier to diagnose.
     * ================================================================================
     */
    connect_timeout: 10,
    /**
     * ==================== TRANSACTION POOLING FORBIDS PREPARED STATEMENTS ====================
     * postgres.js prepares statements by default. Supabase's transaction pooler hands a
     * different backend connection to each transaction, so a statement prepared on one and
     * executed on another fails -- intermittently, as `prepared statement "s1" already
     * exists` or `does not exist`, which reads as a bug in the query rather than in the
     * connection setup.
     *
     * Off unconditionally, not just when the URL looks pooled. A flag whose value differs
     * between development and production is a flag whose failures only ever appear in
     * production, and the queries here are not hot enough for the optimisation to matter.
     * =====================================================================================
     */
    prepare: false,
    // bigint columns must arrive as BigInt, not as a lossy Number. Money is
    // stored in micros precisely so it never touches floating point.
    types: {
      bigint: postgres.BigInt,
    },
    // Set per CONNECTION, not by issuing `SET search_path` once. The pool opens
    // connections lazily, so a one-off SET applies to whichever connection
    // happened to run it and every other query silently hits the default schema.
    ...(opts.searchPath ? { connection: { search_path: opts.searchPath } } : {}),
  })
  return { db: drizzle(sql, { schema }), sql }
}

/**
 * Optional schema override.
 *
 * `createDb` has always supported an isolated schema -- the e2e suite owns one --
 * but the app singleton could not use it, so the only way to point the running app
 * at a throwaway schema was to edit DATABASE_URL and hope the driver honoured an
 * `options=-csearch_path` parameter (postgres.js does not).
 *
 * With this, `DATABASE_SCHEMA=rnr_crm_smoke pnpm dev` runs the whole app against a
 * disposable copy of the schema. That is how the voice webhooks get smoke-tested
 * end to end without a single write landing in real data.
 *
 * Unset means the default search_path, which is the normal case.
 */
export function getDatabaseSchema(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const schema = env['DATABASE_SCHEMA']?.trim()
  if (!schema) return undefined
  // Interpolated into a connection parameter, so it is constrained rather than
  // trusted -- a schema name is an identifier, not free text.
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(
      `DATABASE_SCHEMA="${schema}" is not a plain identifier. Use letters, digits and underscores.`,
    )
  }
  return schema
}

export function db(): Database {
  if (!cached) {
    const searchPath = getDatabaseSchema()
    cached = createDb(getDatabaseUrl(), searchPath ? { searchPath } : {})
  }
  return cached.db
}

export function rawSql(): postgres.Sql {
  if (!cached) cached = createDb(getDatabaseUrl())
  return cached.sql
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.sql.end({ timeout: 5 })
    cached = null
  }
}

export { schema }
