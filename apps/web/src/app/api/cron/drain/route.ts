import { drainQueues, db } from '@rnr/data'

/**
 * The queue consumer, for a host with no always-on process.
 *
 * ==================== WHAT THIS REPLACES ====================
 * `pnpm worker` is an infinite poll loop. On Vercel nothing runs between requests, so
 * without this route the enqueue side keeps working and NOTHING drains: recordings are
 * never fetched, lead alerts are never texted, SERP checks never run. Every one of those
 * failures is silent -- the call row appears, the dashboard looks healthy, and the
 * contractor simply never hears about the lead.
 *
 * The loop body itself lives in `@rnr/data` and is shared with the worker, so there is
 * still exactly one consumer implementation. Claims are `FOR UPDATE SKIP LOCKED`, so an
 * overlapping invocation -- or a laptop worker running at the same time -- cannot take
 * the same job twice.
 * ==========================================================
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Vercel kills the invocation at this deadline with no chance to clean up, so the drain's
 * own budget is set well inside it. 300s is the Pro maximum for a Node function.
 */
export const maxDuration = 300

/**
 * Wall-clock budget for one drain invocation.
 *
 * maxDuration is 300s; we leave headroom so Vercel does not hard-kill mid-job.
 * Discovery jobs are fat (organic + optional volume/maps); 45s was too tight and
 * produced mass "This operation was aborted" permanent fails.
 */
const BUDGET_MS = 180_000

export async function GET(req: Request): Promise<Response> {
  const expected = process.env['CRON_SECRET']?.trim()

  /**
   * ==================== NO SECRET MEANS CLOSED, NOT OPEN ====================
   * This endpoint spends money -- SERP purchases and outbound SMS. An unset secret must
   * fail closed. The tempting alternative, "skip the check when no secret is configured",
   * is how a misconfigured deploy becomes a public endpoint that anyone can hold open to
   * run up a DataForSEO bill.
   * ========================================================================
   */
  if (!expected) {
    return json({ ok: false, error: 'CRON_SECRET is not set, so this endpoint is disabled.' }, 503)
  }

  // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
  const presented = req.headers.get('authorization')
  if (presented !== `Bearer ${expected}`) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

  const workerId = `vercel-cron:${process.env['VERCEL_DEPLOYMENT_ID'] ?? 'local'}`
  const lines: string[] = []

  try {
    const result = await drainQueues({
      db: db(),
      workerId,
      budgetMs: BUDGET_MS,
      log: (m) => {
        lines.push(m)
        console.log(`[drain] ${m}`)
      },
    })

    /**
     * `timedOut` is reported rather than smoothed over. One cron a minute is a capacity
     * assumption, and this is the only place it is ever tested: a drain that keeps hitting
     * its budget means the queue is growing faster than it empties.
     */
    if (result.timedOut) {
      console.warn(
        `[drain] Hit the ${BUDGET_MS}ms budget with work remaining ` +
          `(${result.voice} voice, ${result.serp} serp, ${result.discovery} discovery). ` +
          `The queue is not keeping up.`,
      )
    }

    return json({ ok: true, ...result, log: lines })
  } catch (e) {
    // A 500 here is worth surfacing: Vercel records cron failures, and a drain that
    // cannot connect to the database is exactly the outage that must not look healthy.
    const message = (e as Error).message ?? String(e)
    console.error(`[drain] FAILED: ${message}`)
    return json({ ok: false, error: message, log: lines }, 500)
  }
}

/** Cron invokes GET; POST is accepted so the route can be triggered by hand identically. */
export const POST = GET

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
