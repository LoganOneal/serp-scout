import 'server-only'

/**
 * A deadline for anything that talks to the database.
 *
 * ==================== WHY A PAGE MUST NEVER WAIT FOREVER ====================
 * Under a burst of concurrent requests, a small number of queries against the transaction
 * pooler stop returning. `connect_timeout` does not cover it -- the connection is already
 * established, it has simply gone quiet -- so postgres.js waits, the render waits, and the
 * request produces ZERO bytes until the platform kills it at 300 seconds. The browser shows
 * a spinner, the logs show nothing, and there is no way to tell that from a slow query.
 *
 * This codebase already has the right answer for a measurement it could not obtain: report
 * it as unknown. Every page loader wraps its queries in `.catch()` and falls back to a null
 * or an empty list, which the UI renders as an em dash and labels "not measured". A timeout
 * turns an invisible hang into exactly that: a page that loads, shows what it has, and is
 * honest about the rest.
 *
 * The one thing it must never do is let a timeout look like a zero. That is the caller's
 * responsibility, and it is why the fallback lives at each call site rather than here.
 * =========================================================================
 */

/** Long enough that a genuinely slow query still completes; short enough to notice. */
export const DEFAULT_QUERY_TIMEOUT_MS = 8_000

export class QueryTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    super(`Query "${label}" did not return within ${ms}ms.`)
    this.name = 'QueryTimeoutError'
  }
}

/**
 * Reject if `work` has not settled in time.
 *
 * Rejects rather than resolving to a fallback so that the DECISION about what a missing
 * measurement means stays with the caller. A helper that quietly substituted `0` here would
 * reintroduce the exact bug this repository is organised against, in one shared place.
 *
 * The underlying query is not cancelled -- it cannot be, and it will settle or the
 * connection will be reaped by `idle_timeout`. This bounds the RENDER, not the query.
 */
export async function withQueryTimeout<T>(
  label: string,
  work: () => Promise<T>,
  ms: number = DEFAULT_QUERY_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueryTimeoutError(label, ms)), ms)
      }),
    ])
  } finally {
    // Without this the pending timer keeps the event loop alive, which in a CLI script
    // shows up as a process that will not exit.
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Run it with a deadline, and fall back to a stated value.
 *
 * `onTimeout` is required and takes no default: the caller must say what "unknown" looks
 * like for this particular measurement. It also logs, because a page silently degrading is
 * how you end up believing a market has no calls when the query merely stalled.
 */
export async function queryOr<T>(
  label: string,
  work: () => Promise<T>,
  onTimeout: T,
  ms: number = DEFAULT_QUERY_TIMEOUT_MS,
): Promise<T> {
  try {
    return await withQueryTimeout(label, work, ms)
  } catch (e) {
    console.warn(`[db] ${label} unavailable, rendering it as unknown: ${(e as Error).message}`)
    return onTimeout
  }
}
