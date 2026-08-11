/**
 * Error types for the DataForSEO client.
 *
 * The distinction that matters: `AccountIssueError` must ABORT A RUN, while a
 * `DfsTaskError` on one keyword may be tolerated and recorded as a gap. Anything
 * that swallows the former into "no results" turns a suspended account into a
 * corpus-wide buy recommendation.
 */

export class DfsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly bodyPreview: string,
  ) {
    super(`DataForSEO ${path} returned HTTP ${status}: ${bodyPreview.slice(0, 200)}`)
    this.name = 'DfsHttpError'
  }
}

/**
 * The response was HTTP 200 but not the JSON envelope we expect -- an HTML error
 * page, a proxy interstitial, a truncated body.
 *
 * This class of failure is why the client asserts response SHAPE and not just
 * status. The Census API does exactly this: a missing key yields an 8,529-byte
 * HTML "Missing Key" page under HTTP 200.
 */
export class DfsShapeError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
    readonly bodyPreview: string,
  ) {
    super(`DataForSEO ${path} returned an unexpected body shape (${detail}): ${bodyPreview.slice(0, 200)}`)
    this.name = 'DfsShapeError'
  }
}

/** A task-level failure: HTTP 200, but tasks[0].status_code !== 20000. */
export class DfsTaskError extends Error {
  constructor(
    readonly path: string,
    readonly statusCode: number,
    readonly statusMessage: string,
  ) {
    super(`DataForSEO ${path} task failed with ${statusCode}: ${statusMessage}`)
    this.name = 'DfsTaskError'
  }
}

/**
 * The account cannot currently serve requests: suspended, paused, out of
 * balance, payment failed.
 *
 * MUST NOT be degraded into an empty result set anywhere. A run that hits this
 * dies, and the scan_run is marked failed with this message attached, because
 * the alternative is scoring every SERP in the locality as having no
 * competitors.
 */
export class AccountIssueError extends Error {
  constructor(
    readonly statusCode: number,
    readonly statusMessage: string,
  ) {
    super(
      `DataForSEO account issue (${statusCode}): ${statusMessage}. ` +
        'Aborting -- treating this as "no results" would score every SERP as wide open.',
    )
    this.name = 'AccountIssueError'
  }
}

/**
 * The account is fine; we simply asked too fast.
 *
 * ==================== NOT AN ACCOUNT ISSUE, AND THE DIFFERENCE IS A RUN ====
 * DataForSEO answers "The rates limit per minute has been exceeded: 6 >= 6"
 * with status 40202, which sits inside the 402xx payment/access range that
 * `throwIfAccountIssue` treated wholesale as fatal. So a momentary rate limit
 * -- the most ordinary, most recoverable failure this client has -- marked the
 * whole discovery run FAILED and every pending job with it.
 *
 * Observed: run 35 died this way on 2026-08-10 with every job marked failed.
 * (The 100 market-cell jobs that failed on 2026-08-05 were NOT this -- those
 * carry 40201 "account temporarily paused", a real account issue that the
 * blanket range handled correctly. Checked rather than assumed.)
 *
 * The original reasoning behind the blanket range is still right: a paused
 * account must abort a run, because empty SERPs would score every market as
 * wide open. A rate limit says nothing about the account. It is retried, and
 * if it persists the caller requeues rather than condemning the run.
 * ==========================================================================
 */
export class RateLimitError extends Error {
  constructor(
    readonly statusCode: number,
    readonly statusMessage: string,
  ) {
    super(`DataForSEO rate limit (${statusCode}): ${statusMessage}. Retrying.`)
    this.name = 'RateLimitError'
  }
}

/** The per-run budget cap would be exceeded by the next purchase. */
export class BudgetExceededError extends Error {
  constructor(
    readonly spentMicros: bigint,
    readonly capMicros: bigint,
    readonly attemptedMicros: bigint,
  ) {
    super(
      `Budget cap reached: spent ${spentMicros} micros of ${capMicros}, next purchase needs ${attemptedMicros}.`,
    )
    this.name = 'BudgetExceededError'
  }
}

/** True for errors that must terminate a run rather than be recorded as a gap. */
export function isFatalProviderError(e: unknown): boolean {
  // RateLimitError is deliberately absent: it is the one 402xx that recovers
  // on its own, and treating it as fatal is what failed whole runs.
  return e instanceof AccountIssueError || e instanceof BudgetExceededError
}

/** True for errors worth retrying rather than recording. */
export function isRetryableProviderError(e: unknown): boolean {
  return e instanceof RateLimitError
}
