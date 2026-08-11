import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Architectural guard: every queue consumer collects queued SERPs.
 *
 * ==================== WHAT THIS COST ====================
 * A run with `useQueuedSerp` posts its SERPs -- billed at task_post time --
 * and parks every job at status='awaiting'. Collection lived only in
 * worker/drain.ts, which serves `pnpm worker` and the cron route. The
 * Trigger.dev task, which is the PRIMARY drainer and is dispatched by every
 * enqueue, called drainDiscoveryOnce and nothing else.
 *
 * So a queued sweep ended with no PENDING jobs, which reads to that loop as
 * "queue empty": three empty polls and exit. Nothing ever moved those jobs
 * again. Observed on run 35 -- 32 jobs stuck at `awaiting` across four
 * dispatches over ten minutes.
 *
 * DataForSEO discards a finished task's result after a few days, so a consumer
 * without a collector does not just stall a run, it discards SERPs that were
 * paid for. That is why this is asserted rather than remembered.
 * =======================================================
 */

const CONSUMERS = [
  {
    name: 'trigger.dev discovery-drain',
    path: new URL('../../../../apps/web/src/trigger/discovery-drain.ts', import.meta.url),
  },
  {
    name: 'worker/cron drain loop',
    path: new URL('./drain.ts', import.meta.url),
  },
] as const

describe('queue consumers collect what has already been paid for', () => {
  for (const consumer of CONSUMERS) {
    it(`${consumer.name} calls collectQueuedSerpJobs`, () => {
      const src = readFileSync(fileURLToPath(consumer.path), 'utf8')
      expect(
        src.includes('collectQueuedSerpJobs'),
        `${consumer.name} drains the discovery queue but never collects queued SERPs. ` +
          'A run using useQueuedSerp will park every job at `awaiting` and this consumer ' +
          'will read that as an empty queue, abandoning SERPs that were already billed.',
      ).toBe(true)
    })
  }

  it('the trigger consumer collects BEFORE deciding the queue is empty', () => {
    // Collecting only at the top of the task would still abandon a run whose
    // tasks are not ready yet -- which is the normal case, since queued SERPs
    // take minutes. The collect has to sit on the no-pending-work branch.
    const src = readFileSync(fileURLToPath(CONSUMERS[0].path), 'utf8')
    const emptyBranch = src.slice(src.indexOf('if (!did) {'), src.indexOf('emptyPolls += 1'))
    expect(
      emptyBranch,
      'The empty-poll branch must attempt a collection before counting the poll.',
    ).toContain('collectQueued')
  })
})

/**
 * The other half of the queued path: a posted-but-uncollected job must hold
 * its run open.
 */
describe('an awaiting job keeps its run alive', () => {
  const ROLLUP = readFileSync(
    fileURLToPath(new URL('../serp/run-discovery.ts', import.meta.url)),
    'utf8',
  )
  const body = ROLLUP.slice(
    ROLLUP.indexOf('export async function rollupDiscoveryRun'),
    ROLLUP.indexOf('// Run one job'),
  )

  it('counts awaiting alongside the other job statuses', () => {
    // Without this the count is silently zero and the run looks finished.
    expect(body).toMatch(/c\.status === 'awaiting'/)
  })

  it('treats awaiting as still-working, not as an empty queue', () => {
    // The guard that decides whether to mark the run complete.
    const guard = body.slice(body.indexOf('if (pending > 0'), body.indexOf('finalStatus'))
    expect(
      guard,
      'rollupDiscoveryRun completes a run when pending and claimed are zero. A queued ' +
        'run parks every job at `awaiting`, so omitting it here marks the run done before ' +
        'a single paid result has been collected, and skips the rest as run_cancelled_or_done.',
    ).toContain('awaiting > 0')
  })
})

/**
 * Two collectors must not process the same purchased SERP.
 */
describe('queued collection claims a job before fetching it', () => {
  const SRC = readFileSync(
    fileURLToPath(new URL('../serp/run-discovery.ts', import.meta.url)),
    'utf8',
  )
  const body = SRC.slice(
    SRC.indexOf('export async function collectQueuedSerpJobs'),
    SRC.length,
  )

  it('transitions the job out of awaiting before calling task_get', () => {
    // The awaiting rows are read without a lock, so the conditional UPDATE is
    // the only thing stopping two collectors from both fetching one task id.
    const beforeFetch = body.slice(0, body.indexOf('getSerpTaskResult'))
    expect(
      beforeFetch,
      'collectQueuedSerpJobs must claim a job (UPDATE ... WHERE status = awaiting) ' +
        'before fetching it. Without the claim, two overlapping collectors both call ' +
        'task_get on the same id -- which returns 40601 and destroys a paid result -- ' +
        'and both insert metrics, violating discovery_serp_metrics_job_uq.',
    ).toMatch(/status: 'claimed'/)
  })

  it('skips a job another collector already claimed', () => {
    expect(body).toMatch(/claimed\.length === 0/)
  })

  it('returns a failed claim-and-fetch to awaiting, not to claimed', () => {
    // The next pass only looks at `awaiting`; a job left `claimed` is stranded.
    const catchBlock = body.slice(body.indexOf('} catch (err) {'))
    expect(catchBlock).toMatch(/status: 'awaiting'/)
  })
})
