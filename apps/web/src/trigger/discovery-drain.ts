/**
 * Trigger.dev consumer for the discovery job queue.
 *
 * Reuses Postgres skip-locked claims + runDiscoveryJob — same logic as
 * `/api/cron/drain` and `pnpm worker`, but with long maxDuration and retries.
 */
import { logger, schedules, task } from '@trigger.dev/sdk/v3'
import {
  collectQueuedSerpJobs,
  createProviders,
  db,
  drainDiscoveryOnce,
  redriveStuckDiscoveryJobs,
} from '@rnr/data'

const WORKER_PREFIX = 'trigger'

/**
 * Process pending discovery SERP jobs until the soft budget or queue is empty.
 * Prefer one long run after enqueue; schedule is a safety net.
 */
export const discoveryDrain = task({
  id: 'discovery-drain',
  // Long enough for a fat board deep dive (organic + volume + maps).
  maxDuration: 900, // 15 minutes
  retry: {
    maxAttempts: 5,
    factor: 1.5,
    minTimeoutInMs: 3_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  run: async (payload: {
    /**
     * Confine claims to one run. Omit to act as a general consumer and drain
     * whatever is pending -- which is what the schedule below wants, and what a
     * run-specific dispatch must NOT do.
     */
    runId?: number
    /** Soft wall-clock budget inside the task (ms). Default 12 min. */
    budgetMs?: number
    /** Max jobs to process this invocation. Default 500. */
    maxJobs?: number
  }) => {
    const budgetMs = payload.budgetMs ?? 12 * 60_000
    const maxJobs = payload.maxJobs ?? 500
    const workerId = `${WORKER_PREFIX}:${payload.runId ?? 'any'}:${Date.now()}`
    const database = db()
    const started = Date.now()

    const redriven = await redriveStuckDiscoveryJobs(database)
    if (redriven > 0) {
      logger.info('Re-drove stuck discovery jobs', { redriven })
    }

    let processed = 0
    let emptyPolls = 0

    /**
     * Collect SERPs this project has ALREADY PAID FOR.
     *
     * ==================== THE QUEUED PATH HAD NO COLLECTOR HERE ====================
     * A run with `useQueuedSerp` posts its SERPs (billed at task_post time) and
     * parks every job at status='awaiting'. Collection lived only in the other
     * drain loop, in worker/drain.ts, which serves `pnpm worker` and the cron
     * route. This task -- the PRIMARY drainer, dispatched by every enqueue --
     * called drainDiscoveryOnce and nothing else.
     *
     * So a queued sweep ended with no PENDING jobs at all, which reads to the
     * loop below as "queue empty": three empty polls and exit. The awaiting
     * jobs were never touched again by anyone. Observed on run 35, where 32
     * jobs sat at `awaiting` across four separate dispatches over ten minutes.
     *
     * DataForSEO discards a completed task's result after a few days, so this
     * did not merely stall a run -- it threw away SERPs that were bought.
     * ==============================================================================
     */
    const collectQueued = async (): Promise<number> => {
      try {
        const q = await collectQueuedSerpJobs(database, {
          providers: createProviders(),
          maxJobs: 200,
        })
        if (q.collected > 0 || q.failed > 0 || q.stillWaiting > 0) {
          logger.info('Queued SERPs', {
            collected: q.collected,
            stillWaiting: q.stillWaiting,
            failed: q.failed,
            runId: payload.runId ?? null,
          })
        }
        return q.collected
      } catch (err) {
        // A collector failure must not stop the live path.
        logger.warn('Queued SERP collection failed', {
          error: (err as Error).message.slice(0, 200),
        })
        return 0
      }
    }

    // Finish what is already bought before starting anything new.
    processed += await collectQueued()

    while (processed < maxJobs && Date.now() - started < budgetMs) {
      const did = await drainDiscoveryOnce(database, {
        workerId,
        ...(payload.runId === undefined ? {} : { runId: payload.runId }),
        log: (m) => logger.info(m, { runId: payload.runId }),
      })
      if (!did) {
        /**
         * No PENDING job is not the same as no work. Queued SERPs sit in
         * `awaiting`, so this is exactly the state a queued run spends most of
         * its life in -- and treating it as an empty queue is what abandoned
         * them. Collect before counting the poll as empty.
         */
        const collected = await collectQueued()
        if (collected > 0) {
          processed += collected
          emptyPolls = 0
          continue
        }
        emptyPolls += 1
        // Brief pause then retry — cron-like safety for late enqueues.
        if (emptyPolls >= 3) break
        // Queued tasks take minutes, so poll slower than the live path would.
        await new Promise((r) => setTimeout(r, 15_000))
        continue
      }
      emptyPolls = 0
      processed += 1
    }

    const elapsedMs = Date.now() - started
    logger.info('discovery-drain finished', {
      processed,
      elapsedMs,
      runId: payload.runId ?? null,
      redriven,
    })

    return {
      processed,
      elapsedMs,
      redriven,
      runId: payload.runId ?? null,
      timedOut: elapsedMs >= budgetMs && processed > 0,
    }
  },
})

/**
 * Safety net: drain pending discovery jobs if enqueue kickoff was missed.
 * Enable/disable this schedule in the Trigger.dev dashboard after first deploy.
 */
export const discoveryDrainSchedule = schedules.task({
  id: 'discovery-drain-schedule',
  // Every 5 minutes
  cron: '*/5 * * * *',
  maxDuration: 600,
  run: async () => {
    // Fan out a drain task (do not nest wait — keep schedule light).
    await discoveryDrain.trigger({
      budgetMs: 8 * 60_000,
      maxJobs: 200,
    })
    return { kicked: true }
  },
})
