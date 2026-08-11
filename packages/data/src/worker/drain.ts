import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { centsToMicros, formatMicrosUsd } from '@rnr/core'
import type { Database } from '../db.js'
import { serpKeywords } from '../schema.js'
import { createProviders } from '../providers/index.js'
import { createVoiceProviders } from '../providers/voice.js'
import { claimLeadDelivery, claimNextVoiceJob, redriveStuckVoiceJobs } from '../voice/jobs.js'
import { runVoiceJob } from '../voice/run-job.js'
import {
  claimNextTarget,
  dailyCapCents,
  rescheduleTarget,
  runTargetCheck,
  spentTodayMicros,
} from '../serp/run-check.js'
import {
  claimNextDiscoveryJob,
  collectQueuedSerpJobs,
  isRetriableDiscoveryError,
  redriveStuckDiscoveryJobs,
  requeueDiscoveryJob,
  runDiscoveryJob,
} from '../serp/run-discovery.js'

/**
 * Queue draining, independent of what is calling it.
 *
 * ==================== TWO RUNTIMES, ONE CONSUMER ====================
 * This logic used to live inside `worker/main.ts`, an infinite `while` loop -- which is
 * correct on a laptop and impossible on Vercel, where nothing runs between requests. The
 * naive fix is a second copy of the loop body inside a cron route, and then there are two
 * consumers of the queue that drift apart: the bug this codebase already paid for once,
 * when an enqueue path and a consumer path were never connected.
 *
 * So the body moved here and both callers use it. `pnpm worker` calls it in a loop;
 * `/api/cron/drain` calls it until a deadline. The claims are `FOR UPDATE SKIP LOCKED`
 * either way, so the two can even run at the same time without double-processing a job.
 * ==================================================================
 */

export type Log = (message: string) => void

export interface DrainCounts {
  voice: number
  serp: number
  discovery: number
}

/**
 * One voice job: a recording download or a lead alert.
 *
 * Drained BEFORE SERP checks. A lead alert is supposed to reach the contractor within
 * seconds and a ranking check is daily, so ordering these the other way round would park
 * an emergency text behind a SERP purchase.
 */
export async function drainVoiceOnce(
  db: Database,
  args: { workerId: string; log: Log },
): Promise<boolean> {
  const job = await claimNextVoiceJob(db, args.workerId)
  if (!job) return false

  const res = await runVoiceJob(db, {
    job,
    providers: createVoiceProviders(),
    log: (m) => args.log(`  voice#${job.id} ${m}`),
  })
  if (!res.ok) args.log(`Voice job #${job.id} (${job.kind}) did not complete: ${res.detail}`)
  return true
}

/**
 * One due SERP target.
 *
 * `serp_targets.next_check_at` IS the queue -- no extra table, same claim pattern as
 * `scan_runs`. The daily cap is checked before the purchase, not after: a monitor that
 * notices it overspent has already overspent.
 */
export async function drainSerpOnce(
  db: Database,
  args: { workerId: string; log: Log },
): Promise<boolean> {
  const target = await claimNextTarget(db, args.workerId)
  if (!target) return false

  const providers = createProviders()
  const capMicros = centsToMicros(dailyCapCents())

  // The keyword's site owns the budget, so the cap is per cell rather than global.
  const siteId = await siteIdForTarget(db, target.keywordId)
  const spent = siteId === null ? 0n : await spentTodayMicros(db, siteId)

  if (siteId !== null && spent >= capMicros) {
    // Deferred, not failed: tomorrow's budget will run it. Rescheduling past midnight
    // rather than retrying in a loop is what stops a capped cell from spinning.
    await rescheduleTarget(db, target.id, 24)
    args.log(
      `SERP check for target #${target.id} deferred -- cell ${siteId} has spent ` +
        `${formatMicrosUsd(spent)} of its ${formatMicrosUsd(capMicros)} daily cap.`,
    )
    return true
  }

  const outcome = await runTargetCheck(db, {
    target,
    providers,
    fetchPage: async (url) => {
      const page = await providers.fetchPageHtml(url)
      return { html: page.html, costMicros: page.costMicros }
    },
  })

  // 24h on success; sooner on a measurement failure so a transient block is retried today.
  await rescheduleTarget(db, target.id, outcome.serpMeasured ? 24 : 4)

  const rankLabel = !outcome.serpMeasured
    ? 'NOT MEASURED'
    : outcome.serpPosition !== null && outcome.serpPackPosition !== null
      ? `#${outcome.serpPosition}+disc#${outcome.serpPackPosition}`
      : outcome.serpPosition !== null
        ? `#${outcome.serpPosition}`
        : outcome.serpPackPosition !== null
          ? `disc#${outcome.serpPackPosition}`
          : 'not ranking'
  args.log(
    `SERP #${target.id} "${outcome.keyword}": ` +
      `serp=${rankLabel} ` +
      `comment=${outcome.commentPresent === null ? 'unmeasured' : outcome.commentPresent ? `#${outcome.commentRank}` : 'ABSENT'} ` +
      `cost=${formatMicrosUsd(outcome.costMicros)}` +
      (outcome.error === null ? '' : ` -- ${outcome.error}`),
  )
  return true
}

/**
 * Send one lead's alert right now, if it is still pending.
 *
 * ==================== THE CRON IS THE RETRY NET, NOT THE PATH ====================
 * A cron that fires every minute means an emergency text could arrive up to 60 seconds
 * after the caller said "I smell gas" -- while they are still on the phone. So the
 * save_lead handler calls this in `waitUntil`, after its response has already gone back to
 * Retell, and the drain only picks up what this missed or what failed.
 *
 * Returns quietly when there is nothing pending: a duplicate save_lead for the same lead is
 * the normal case (the agent calls it repeatedly as it learns things), and only the first
 * enqueue creates a job.
 * ==============================================================================
 */
export async function deliverLeadNow(
  db: Database,
  args: { leadId: number; workerId: string; log?: Log },
): Promise<{ ran: boolean; detail: string }> {
  const log = args.log ?? (() => {})
  const job = await claimLeadDelivery(db, args)
  if (job === null) return { ran: false, detail: 'no pending delivery job' }

  const res = await runVoiceJob(db, {
    job,
    providers: createVoiceProviders(),
    log: (m) => log(`  lead#${args.leadId} ${m}`),
  })
  return { ran: true, detail: res.detail }
}

/** Which cell's budget pays for a target. */
async function siteIdForTarget(db: Database, keywordId: number): Promise<number | null> {
  const [row] = await db
    .select({ siteId: serpKeywords.siteId })
    .from(serpKeywords)
    .where(eq(serpKeywords.id, keywordId))
    .limit(1)
  return row?.siteId ?? null
}

/**
 * One discovery SERP (or later commentability) job.
 *
 * Priority: after SERP monitor, before locality scans (scans stay main.ts-only).
 * Full grids assume long-lived `pnpm worker`; cron advances slowly under budgetMs.
 */
export async function drainDiscoveryOnce(
  db: Database,
  args: { workerId: string; log: Log; runId?: number },
): Promise<boolean> {
  const job = await claimNextDiscoveryJob(db, args.workerId, { runId: args.runId })
  if (!job) return false

  try {
    const providers = createProviders()
    const outcome = await runDiscoveryJob(db, { job, providers })
    args.log(
      `Discovery #${job.id} run=${job.runId} "${job.keyword ?? job.kind}": ` +
        `${outcome.status} hits=${outcome.hitCount} cost=${formatMicrosUsd(outcome.costMicros)}` +
        (outcome.error ? ` -- ${outcome.error}` : ''),
    )
  } catch (e) {
    // Never leave a claimed job hanging. Retriable errors go back to pending.
    const message = ((e as Error).message ?? String(e)).slice(0, 500)
    args.log(`Discovery #${job.id} run=${job.runId}: uncaught -- ${message}`)
    if (isRetriableDiscoveryError(e)) {
      const rq = await requeueDiscoveryJob(db, {
        jobId: job.id,
        runId: job.runId,
        // Uncaught here usually means pre-reserve (createProviders). Do not refund.
        // runDiscoveryJob already refunds when it requeues after reserve.
        reservedCostMicros: 0n,
        reason: message,
        previousError: job.error,
      })
      args.log(
        `Discovery #${job.id}: ${rq.status} (retry ${rq.retries}) after retriable error`,
      )
    } else {
      await db.execute(sql`
        UPDATE discovery_jobs
           SET status = 'failed',
               finished_at = now(),
               claimed_at = null,
               claimed_by = null,
               error = ${message}
         WHERE id = ${job.id}
           AND status = 'claimed'
      `)
    }
  }
  return true
}

export interface DrainResult extends DrainCounts {
  redriven: number
  /** True when queues came back empty -- there is nothing left to do right now. */
  drained: boolean
  /** True when the time budget ran out first, so work remains. */
  timedOut: boolean
  elapsedMs: number
}

/**
 * Has discovery been handed to Trigger.dev?
 *
 * ==================== WHY THE CRON STEPS BACK ====================
 * Skip-locked claims mean two consumers cannot corrupt anything or double-spend, so this
 * is not a safety gate -- it is an ownership one. A cron tick every 60s and a Trigger task
 * with a 12-minute budget will happily split one deep dive between them, which makes the
 * Trigger run report a job count that has nothing to do with the run it was dispatched
 * for, and puts fat SERP jobs back inside the serverless budget we moved them out of.
 *
 * Only the discovery CLAIMS move. Voice, SERP monitor, and the stuck-job redrive stay on
 * cron -- redrive especially, since it is what rescues a Trigger run that died mid-job.
 *
 * Kill switch: unset TRIGGER_SECRET_KEY and the cron picks discovery back up next tick.
 * ==============================================================
 */
export function discoveryHandledByTrigger(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['TRIGGER_SECRET_KEY']?.trim())
}

/**
 * Drain both queues until they are empty or the time budget is spent.
 *
 * ==================== A BUDGET, NOT A JOB COUNT ====================
 * A serverless invocation is killed at its `maxDuration` with no chance to finish, and a
 * job killed mid-flight stays `claimed` until the redrive sweep reclaims it -- so a lead
 * text could sit for an hour. Bounding by wall clock instead of by job count means the
 * function always returns of its own accord, and whatever is left is claimed by the next
 * minute's invocation.
 *
 * `timedOut: true` is the signal that work remains. It is reported rather than smoothed
 * over, because "the drain keeps hitting its budget" is how you learn one cron a minute is
 * no longer enough.
 * ================================================================
 */
export async function drainQueues(args: {
  db: Database
  workerId: string
  log?: Log
  /** Wall-clock budget. Must be comfortably under the platform's kill deadline. */
  budgetMs: number
  now?: () => number
  /** Override the Trigger.dev handoff. Defaults to `discoveryHandledByTrigger()`. */
  skipDiscovery?: boolean
}): Promise<DrainResult> {
  const log = args.log ?? (() => {})
  const now = args.now ?? (() => Date.now())
  const started = now()
  const spent = (): number => now() - started
  const counts: DrainCounts = { voice: 0, serp: 0, discovery: 0 }

  const redrivenVoice = await redriveStuckVoiceJobs(args.db)
  if (redrivenVoice > 0) log(`Re-drove ${redrivenVoice} stuck voice job(s) back to pending.`)
  const redrivenDiscovery = await redriveStuckDiscoveryJobs(args.db)
  if (redrivenDiscovery > 0) {
    log(`Re-drove ${redrivenDiscovery} stuck discovery job(s).`)
  }
  const redriven = redrivenVoice + redrivenDiscovery

  const skipDiscovery = args.skipDiscovery ?? discoveryHandledByTrigger()
  if (skipDiscovery) {
    log('Discovery is handled by Trigger.dev; draining voice + serp only.')
  }

  let drained = false
  // Do not start a discovery job unless enough wall clock remains for one full
  // organic call (Vercel DFS timeout 45s) plus a little DB write headroom.
  const headroomMs = process.env['VERCEL'] ? 55_000 : 5_000
  const hardStop = () => spent() >= args.budgetMs - headroomMs

  while (!hardStop()) {
    if (await drainVoiceOnce(args.db, { workerId: args.workerId, log })) {
      counts.voice += 1
      continue // Voice first, always: drain it fully before buying a SERP.
    }
    if (hardStop()) break
    if (await drainSerpOnce(args.db, { workerId: args.workerId, log })) {
      counts.serp += 1
      continue
    }
    if (hardStop()) break
    // On Vercel: 1 discovery job per tick (organic + optional volume/maps is fat).
    // Local worker: burst so bulk screens finish quickly.
    // Handed to Trigger.dev: 0, so this consumer stops competing for the claims.
    /**
     * Collect queued SERPs before claiming new work.
     *
     * These are already paid for, so finishing them beats starting anything
     * else -- and DataForSEO discards results after a few days, which would
     * turn a delay into a loss.
     */
    if (!skipDiscovery && !hardStop()) {
      try {
        const q = await collectQueuedSerpJobs(args.db, {
          providers: createProviders(),
          maxJobs: process.env['VERCEL'] ? 20 : 200,
        })
        if (q.collected > 0 || q.failed > 0) {
          counts.discovery += q.collected
          log(
            `Queued SERPs: collected ${q.collected}, still waiting ${q.stillWaiting}` +
              (q.failed > 0 ? `, failed ${q.failed}` : ''),
          )
        }
      } catch (err) {
        // A collector failure must not stop the live path.
        log(`Queued SERP collection failed: ${(err as Error).message.slice(0, 90)}`)
      }
    }

    let discoveryThisRound = 0
    const maxDiscoveryBurst = skipDiscovery ? 0 : process.env['VERCEL'] ? 1 : 8
    while (discoveryThisRound < maxDiscoveryBurst && !hardStop()) {
      if (!(await drainDiscoveryOnce(args.db, { workerId: args.workerId, log }))) {
        break
      }
      counts.discovery += 1
      discoveryThisRound += 1
    }
    if (discoveryThisRound === 0) {
      drained = true
      break
    }
  }

  return { ...counts, redriven, drained, timedOut: !drained, elapsedMs: spent() }
}
