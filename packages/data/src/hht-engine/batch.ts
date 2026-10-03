import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { semrushReplacementNotice } from '@rnr/core'
import { loadEngineConfig } from './config.js'
import type { EngineDatabase } from './db.js'
import { maybeSendDailyDigest } from './digest.js'
import { GadsError } from './gads-client.js'
import {
  blockJob,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  loadCredential,
  setGadsState,
  setSemrushState,
} from './jobs.js'
import { exportPendingLlmTasks, LlmTaskPendingError } from './llm-tasks.js'
import { remindIfDue, runEngineJob, seedFrontier, semrushAuthFailing, sendNotification, sweepStaleJobs } from './run-job.js'
import {
  hhtEngineGoogleAdsUsage,
  hhtEngineJobs,
  hhtEngineRuns,
  hhtEngineSemrushUsage,
  hhtEngineSystemState,
} from './schema.js'
import { SemrushMcpError } from './semrush-mcp.js'

export interface BatchResult {
  runId: string
  status: 'success' | 'locked' | 'wall_clock_limit' | 'semrush_unit_cap' | 'semrush_paused' | 'google_ads_call_cap' | 'failed'
  jobsCompleted: number
  semrushUnits: number
  googleAdsCalls: number
  pendingLlmTasks: number
}

export async function runBatch(
  db: EngineDatabase,
  overrides: {
    wallClockMinutes?: number
    semrushUnitCap?: number | null
    googleAdsCallCap?: number
    llmTaskExportCap?: number
  } = {},
): Promise<BatchResult> {
  const config = loadEngineConfig()
  const runId = randomUUID()
  const owner = `cursor-automation:${runId}`
  const locked = await acquireRunLock(db, owner)
  if (!locked) {
    return { runId, status: 'locked', jobsCompleted: 0, semrushUnits: 0, googleAdsCalls: 0, pendingLlmTasks: 0 }
  }
  const started = Date.now()
  const wallClockMs = (overrides.wallClockMinutes ?? config.batchWallClockMinutes) * 60_000
  const semrushCap = overrides.semrushUnitCap === undefined ? config.semrushUnitCap : overrides.semrushUnitCap
  const gadsCap = overrides.googleAdsCallCap ?? config.googleAdsCallCap
  const baselineSemrush = await semrushUnits(db)
  const baselineGads = await googleAdsCalls(db)
  let jobsCompleted = 0
  let status: BatchResult['status'] = 'success'
  await db.insert(hhtEngineRuns).values({ id: runId, status: 'running' })
  try {
    await sweepStaleJobs(db)
    await seedFrontier(db)
    const [state] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
    if (state?.semrushState === 'AUTH_FAILURE' || state?.semrushState === 'EXHAUSTED') {
      await enqueueJob(db, { type: 'CHECK_SEMRUSH_HEALTH', idempotencyKey: `semrush-health:${runId}`, payload: {} })
    }
    while (true) {
      const used = await semrushUnits(db) - baselineSemrush
      const gads = await googleAdsCalls(db) - baselineGads
      if (Date.now() - started >= wallClockMs) {
        status = 'wall_clock_limit'
        break
      }
      if (semrushCap !== null && used >= semrushCap) {
        status = 'semrush_unit_cap'
        break
      }
      if (gads >= gadsCap) {
        status = 'google_ads_call_cap'
        break
      }
      const job = await claimNextJob(db, owner)
      if (!job) {
        if (await semrushPaused(db)) status = 'semrush_paused'
        break
      }
      await heartbeatRunLock(db, owner)
      try {
        await runEngineJob(db, job)
        await completeJob(db, job.id)
        jobsCompleted += 1
      } catch (error) {
        if (error instanceof LlmTaskPendingError) {
          await blockJob(db, job.id, 'WAITING_ON_LLM')
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof SemrushMcpError && error.kind === 'invalid') {
          await failJob(db, job.id, message, job.maxAttempts, job.maxAttempts)
          continue
        }
        if (error instanceof SemrushMcpError && (error.kind === 'auth' || error.kind === 'exhausted')) {
          const [before] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
          const alreadyPaused = before?.semrushState === 'AUTH_FAILURE' || before?.semrushState === 'EXHAUSTED'
          if (error.kind === 'auth' && !alreadyPaused && !(await semrushAuthFailing(db))) {
            await failJob(db, job.id, message, job.attempts, job.maxAttempts)
            continue
          }
          const nextState = error.kind === 'auth' ? 'AUTH_FAILURE' : 'EXHAUSTED'
          const changed = await setSemrushState(db, nextState)
          await blockJob(db, job.id, 'blocked_on_semrush', message)
          if (changed) {
            const [state] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
            const waiting = await db.select().from(hhtEngineJobs).where(eq(hhtEngineJobs.status, 'blocked_on_semrush'))
            await sendNotification(
              db,
              semrushReplacementNotice({
                reason: error.kind === 'auth' ? 'authorization failed' : 'credits exhausted',
                pausedAt: new Date().toISOString(),
                unitsUsed: state?.unitsUsed ?? 0,
                queuedJobs: waiting.length,
              }),
              {
                subject: 'HHT engine: replace the Semrush account in the Cursor MCP connector',
                eventType: `semrush_${nextState.toLowerCase()}`,
              },
            )
          }
          continue
        }
        if (error instanceof GadsError && error.kind === 'auth') {
          const changed = await setGadsState(db, 'GADS_AUTH_FAILURE')
          await blockJob(db, job.id, 'blocked_on_gads')
          if (changed) {
            await sendNotification(
              db,
              'Google Ads authorization failed. Run `pnpm engine auth:google-ads`. Google Ads jobs are paused; other stages keep running.',
              { subject: 'HHT engine: Google Ads authorization failed', eventType: 'gads_auth_failure' },
            )
          }
          continue
        }
        if (error instanceof GadsError && error.kind === 'rate_limit') {
          await setGadsState(db, 'GADS_RATE_LIMITED')
        }
        await failJob(db, job.id, message, job.attempts, job.maxAttempts)
      }
    }
    await remindIfDue(db)
    await maybeSendDailyDigest(db)
    const pendingLlmTasks = await exportPendingLlmTasks(
      db,
      'llm-tasks.json',
      overrides.llmTaskExportCap ?? config.llmTaskExportCap,
    )
    const used = await semrushUnits(db) - baselineSemrush
    const gads = await googleAdsCalls(db) - baselineGads
    await db.update(hhtEngineRuns).set({
      status,
      finishedAt: new Date(),
      jobsCompleted,
      semrushUnits: used,
      googleAdsCalls: gads,
    }).where(eq(hhtEngineRuns.id, runId))
    await updateRunHealth(db, status)
    return { runId, status, jobsCompleted, semrushUnits: used, googleAdsCalls: gads, pendingLlmTasks }
  } catch (error) {
    status = 'failed'
    await db.update(hhtEngineRuns).set({
      status,
      finishedAt: new Date(),
      jobsCompleted,
      semrushUnits: await semrushUnits(db) - baselineSemrush,
      googleAdsCalls: await googleAdsCalls(db) - baselineGads,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    }).where(eq(hhtEngineRuns.id, runId))
    await updateRunHealth(db, 'failed')
    throw error
  } finally {
    await releaseRunLock(db, owner)
  }
}

export async function acquireRunLock(db: EngineDatabase, owner: string): Promise<boolean> {
  const rows = await db.execute<{ owner: string }>(sql`
    INSERT INTO hht_engine.run_locks (name, owner, acquired_at, heartbeat_at)
    VALUES ('hourly-engine', ${owner}, now(), now())
    ON CONFLICT (name) DO UPDATE
       SET owner = excluded.owner,
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at
     WHERE hht_engine.run_locks.heartbeat_at < now() - interval '30 minutes'
    RETURNING owner
  `)
  return (rows as unknown as Array<{ owner: string }>)[0]?.owner === owner
}

export async function heartbeatRunLock(db: EngineDatabase, owner: string): Promise<void> {
  await db.execute(sql`
    UPDATE hht_engine.run_locks SET heartbeat_at = now()
     WHERE name = 'hourly-engine' AND owner = ${owner}
  `)
}

export async function releaseRunLock(db: EngineDatabase, owner: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM hht_engine.run_locks
     WHERE name = 'hourly-engine' AND owner = ${owner}
  `)
}

async function semrushPaused(db: EngineDatabase): Promise<boolean> {
  const [state] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
  return state?.semrushState === 'AUTH_FAILURE' || state?.semrushState === 'EXHAUSTED'
}

export interface EngineStatus {
  shouldRun: boolean
  reason: string
  semrushState: string
  semrushPausedAt: string | null
  newerSemrushSync: boolean
  gadsState: string
  cheapJobsReady: number
  semrushJobsReady: number
  blockedOnSemrush: number
  waitingOnLlm: number
  lockHeld: boolean
}

/**
 * Reads only the database and vault so a scheduled run can exit before any
 * paid call when there is nothing it could do.
 */
export async function engineStatus(db: EngineDatabase): Promise<EngineStatus> {
  const [state] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
  const semrushState = state?.semrushState ?? 'RUNNING'
  const pausedAt = state?.semrushPausedAt ?? null
  const credential = await loadCredential(db)
  const newerSemrushSync = Boolean(
    pausedAt && credential?.cursorUpdatedAtMs && credential.cursorUpdatedAtMs > pausedAt.getTime(),
  )
  const counts = await db.execute<{ cheap: string; semrush: string; blocked: string; llm: string; locked: string }>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending' AND run_after <= now()
        AND type NOT IN ('FETCH_SERP_BAND', 'EXPAND_KEYWORDS_SEMRUSH', 'FETCH_DOMAIN_METRICS', 'REVERIFY_RANKING'))::text AS cheap,
      count(*) FILTER (WHERE status = 'pending' AND run_after <= now()
        AND type IN ('FETCH_SERP_BAND', 'EXPAND_KEYWORDS_SEMRUSH', 'FETCH_DOMAIN_METRICS', 'REVERIFY_RANKING'))::text AS semrush,
      count(*) FILTER (WHERE status = 'blocked_on_semrush')::text AS blocked,
      count(*) FILTER (WHERE status = 'WAITING_ON_LLM')::text AS llm,
      (SELECT count(*) FROM hht_engine.run_locks
        WHERE name = 'hourly-engine' AND heartbeat_at >= now() - interval '30 minutes')::text AS locked
    FROM hht_engine.jobs
  `)
  const row = (counts as unknown as Array<{ cheap: string; semrush: string; blocked: string; llm: string; locked: string }>)[0]
  const cheapJobsReady = Number(row?.cheap ?? 0)
  const lockHeld = Number(row?.locked ?? 0) > 0
  const paused = semrushState === 'AUTH_FAILURE' || semrushState === 'EXHAUSTED'
  let shouldRun = true
  let reason = 'semrush_running'
  if (lockHeld) {
    shouldRun = false
    reason = 'another_batch_running'
  } else if (paused && newerSemrushSync) {
    reason = 'semrush_resynced'
  } else if (paused && cheapJobsReady > 0) {
    reason = 'non_semrush_work_ready'
  } else if (paused) {
    shouldRun = false
    reason = `semrush_${semrushState.toLowerCase()}_waiting_for_sync`
  }
  return {
    shouldRun,
    reason,
    semrushState,
    semrushPausedAt: pausedAt?.toISOString() ?? null,
    newerSemrushSync,
    gadsState: state?.gadsState ?? 'GADS_RUNNING',
    cheapJobsReady,
    semrushJobsReady: Number(row?.semrush ?? 0),
    blockedOnSemrush: Number(row?.blocked ?? 0),
    waitingOnLlm: Number(row?.llm ?? 0),
    lockHeld,
  }
}

async function semrushUnits(db: EngineDatabase): Promise<number> {
  const rows = await db.select({ total: sql<number>`coalesce(sum(${hhtEngineSemrushUsage.units}), 0)` }).from(hhtEngineSemrushUsage)
  return Number(rows[0]?.total ?? 0)
}

async function googleAdsCalls(db: EngineDatabase): Promise<number> {
  const rows = await db.select({ total: sql<number>`count(*)` }).from(hhtEngineGoogleAdsUsage)
  return Number(rows[0]?.total ?? 0)
}

async function updateRunHealth(
  db: EngineDatabase,
  status: BatchResult['status'],
): Promise<void> {
  const [state] = await db.select().from(hhtEngineSystemState).where(eq(hhtEngineSystemState.id, 1))
  if (!state) return
  if (status === 'success') {
    await db.update(hhtEngineSystemState).set({
      consecutiveFailedRuns: 0,
      consecutiveTimedOutRuns: 0,
      updatedAt: new Date(),
    }).where(eq(hhtEngineSystemState.id, 1))
    return
  }
  if (status === 'wall_clock_limit') {
    const count = state.consecutiveTimedOutRuns + 1
    await db.update(hhtEngineSystemState).set({
      consecutiveTimedOutRuns: count,
      updatedAt: new Date(),
    }).where(eq(hhtEngineSystemState.id, 1))
    if (count === 3) {
      await sendNotification(
        db,
        'The HHT engine hit its wall-clock limit in three consecutive automation runs.',
        { subject: 'HHT engine: repeated wall-clock limits', eventType: 'three_timed_out_runs' },
      )
    }
    return
  }
  if (status === 'failed') {
    const count = state.consecutiveFailedRuns + 1
    await db.update(hhtEngineSystemState).set({
      consecutiveFailedRuns: count,
      updatedAt: new Date(),
    }).where(eq(hhtEngineSystemState.id, 1))
    if (count === 3) {
      await sendNotification(
        db,
        'The HHT engine failed in three consecutive automation runs.',
        { subject: 'HHT engine: repeated automation failures', eventType: 'three_failed_runs' },
      )
    }
  }
}
