import { describe, expect, it } from 'vitest'
import { DEFAULT_POOL_MAX, getDirectDatabaseUrl, poolMax, poolerWarning } from './db.js'

/**
 * Connection settings that differ between a laptop and a serverless runtime.
 *
 * Every one of these is a configuration mistake that WORKS in development and fails under
 * production load, which is the hardest kind to catch by using the app.
 */

function envWith(over: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

const SESSION = 'postgresql://u:p@aws-0-ca-central-1.pooler.supabase.com:5432/postgres'
const TRANSACTION = 'postgresql://u:p@aws-0-ca-central-1.pooler.supabase.com:6543/postgres'

describe('poolMax', () => {
  /**
   * ==================== THE REGRESSION THIS PINS ====================
   * A pool of 1 shipped to production and took every database-backed page down: concurrent
   * queries -- which one render does routinely, `/portfolio` awaits three at once -- never
   * completed against the transaction pooler. No error, no log, zero bytes, killed at 300
   * seconds. Route handlers kept working because they queried sequentially, so the app
   * looked half-alive rather than broken.
   *
   * These assertions are about NEVER RETURNING 1, from any input. That is the defect, not
   * the specific number.
   * ================================================================
   */
  it('never returns 1, on Vercel or anywhere else', () => {
    for (const env of [{ VERCEL: '1' }, { VERCEL: undefined }, { VERCEL: '1', DATABASE_POOL_MAX: '1' }]) {
      expect(poolMax(envWith(env)), JSON.stringify(env)).toBeGreaterThan(1)
    }
  })

  it('refuses a configured 1 instead of trusting it', () => {
    // Not a tuning choice -- the outage above. It would arrive as "the site is down" with
    // nothing in the logs, so it is overridden rather than honoured.
    expect(poolMax(envWith({ DATABASE_POOL_MAX: '1' }))).toBe(DEFAULT_POOL_MAX)
  })

  it('defaults to the same small pool in every runtime', () => {
    // Identical on Vercel and locally, so a page that works in development cannot fail in
    // production over a connection setting that differs between them.
    expect(poolMax(envWith({ VERCEL: '1', DATABASE_POOL_MAX: undefined }))).toBe(DEFAULT_POOL_MAX)
    expect(poolMax(envWith({ VERCEL: undefined, DATABASE_POOL_MAX: undefined }))).toBe(DEFAULT_POOL_MAX)
  })

  it('honours an explicit override above 1', () => {
    expect(poolMax(envWith({ DATABASE_POOL_MAX: '8' }))).toBe(8)
  })

  it('ignores a nonsense override rather than opening zero connections', () => {
    for (const bad of ['0', '-2', 'lots', '']) {
      expect(poolMax(envWith({ DATABASE_POOL_MAX: bad })), bad).toBe(DEFAULT_POOL_MAX)
    }
  })
})

describe('poolerWarning', () => {
  it('flags the SESSION pooler in a serverless runtime', () => {
    expect(poolerWarning(SESSION, envWith({ VERCEL: '1' }))).toMatch(/6543/)
  })

  it('says nothing about the transaction pooler', () => {
    expect(poolerWarning(TRANSACTION, envWith({ VERCEL: '1' }))).toBeNull()
  })

  it('says nothing locally, where the session pooler is the right choice', () => {
    // This is exactly the developer's own DATABASE_URL. Warning about it every boot would
    // train them to ignore the warning that matters.
    expect(poolerWarning(SESSION, envWith({ VERCEL: undefined }))).toBeNull()
  })

  it('says nothing about a direct Postgres, pooler or not', () => {
    expect(poolerWarning('postgresql://u:p@localhost:5432/rnr', envWith({ VERCEL: '1' }))).toBeNull()
  })

  it('does not throw on an unparseable url', () => {
    expect(poolerWarning('not a url', envWith({ VERCEL: '1' }))).toBeNull()
  })
})

describe('getDirectDatabaseUrl', () => {
  it('prefers DIRECT_DATABASE_URL, which is what migrations need', () => {
    expect(getDirectDatabaseUrl(envWith({ DATABASE_URL: TRANSACTION, DIRECT_DATABASE_URL: SESSION }))).toBe(
      SESSION,
    )
  })

  it('falls back to DATABASE_URL, correct for a local Postgres with no pooler', () => {
    expect(getDirectDatabaseUrl(envWith({ DATABASE_URL: SESSION, DIRECT_DATABASE_URL: undefined }))).toBe(
      SESSION,
    )
  })

  it('treats a blank direct url as unset instead of connecting to nothing', () => {
    expect(getDirectDatabaseUrl(envWith({ DATABASE_URL: SESSION, DIRECT_DATABASE_URL: '  ' }))).toBe(
      SESSION,
    )
  })
})
