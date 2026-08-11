import 'server-only'
import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { VoiceJobKind } from '@rnr/core'
import type { Database } from '../db.js'
import { voiceJobs, type VoiceJob } from '../schema.js'

/**
 * The voice job queue. It is the `voice_jobs` table and nothing else.
 *
 * Deliberately the same shape as queue.ts: `FOR UPDATE SKIP LOCKED`, one consumer
 * (`pnpm worker`), no Redis. The INSERT is the enqueue. See the long comment in
 * queue.ts for why -- a second queueing system is a second thing to forget to
 * poll, and that failure is silent.
 *
 * The one difference is `run_after`: recording downloads and SMS sends hit third
 * party APIs that fail transiently, so failures are rescheduled with backoff
 * rather than retried immediately or dropped.
 */

/** A claimed job untouched for this long is presumed dead and re-driven. */
export const STUCK_JOB_MINUTES = 10

/** Give up after this many attempts and leave the row as evidence. */
export const MAX_ATTEMPTS = 5

/** Exponential-ish, capped. 30s, 2m, 8m, 30m. */
export function backoffSeconds(attempt: number): number {
  return Math.min(1800, 30 * 4 ** Math.max(0, attempt - 1))
}

/**
 * Enqueue, idempotently.
 *
 * `voice_jobs_kind_call_uq` makes a second `fetch_recording` for the same call a
 * no-op rather than a duplicate download. Retell retries webhooks up to three
 * times, so without this every recording would be fetched three times and every
 * lead alert texted three times.
 */
export async function enqueueVoiceJob(
  db: Database,
  args: { kind: VoiceJobKind; callId?: number | null; leadId?: number | null },
): Promise<void> {
  await db
    .insert(voiceJobs)
    .values({
      kind: args.kind,
      callId: args.callId ?? null,
      leadId: args.leadId ?? null,
      status: 'pending',
    })
    .onConflictDoNothing({ target: [voiceJobs.kind, voiceJobs.callId] })
}

/**
 * Enqueue a lead delivery.
 *
 * Separate from the above because the unique index is on (kind, call_id), and a
 * lead job carries a lead_id with a null call_id for a future web-form lead. The
 * dedupe there is by lead: one pending delivery at a time.
 */
export async function enqueueLeadDelivery(db: Database, leadId: number): Promise<void> {
  const existing = await db
    .select({ id: voiceJobs.id })
    .from(voiceJobs)
    .where(
      and(
        eq(voiceJobs.kind, 'deliver_lead'),
        eq(voiceJobs.leadId, leadId),
        or(eq(voiceJobs.status, 'pending'), eq(voiceJobs.status, 'claimed')),
      ),
    )
    .limit(1)
  if (existing.length > 0) return

  await db
    .insert(voiceJobs)
    .values({ kind: 'deliver_lead', leadId, status: 'pending' })
}

/** Atomically claim the next due job. Same pattern as claimNextRun. */
export async function claimNextVoiceJob(db: Database, workerId: string): Promise<VoiceJob | null> {
  // Returns the id only, then re-selects through Drizzle -- raw execute() hands
  // back snake_case rows, so `job.callId` would silently be undefined. Same
  // reasoning as queue.ts.
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE voice_jobs
       SET status     = 'claimed',
           claimed_at = now(),
           claimed_by = ${workerId},
           attempts   = attempts + 1
     WHERE id = (
       SELECT id
         FROM voice_jobs
        WHERE status = 'pending'
          AND run_after <= now()
        ORDER BY run_after ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
       AND status = 'pending'
    RETURNING id
  `)
  const id = (rows as unknown as Array<{ id: number }>)[0]?.id
  if (id === undefined) return null

  const [row] = await db.select().from(voiceJobs).where(eq(voiceJobs.id, id))
  return row ?? null
}

/**
 * Claim the pending `deliver_lead` job for ONE lead, jumping the queue.
 *
 * ==================== WHY NOT JUST claimNextVoiceJob ====================
 * The queue is FIFO on `run_after`, which is right for a background drain and wrong for
 * the thing that just happened. On Vercel the immediate send runs in `waitUntil` after the
 * save_lead response; if that call claimed "the next job" it could pick up an unrelated
 * recording download and leave the emergency text for the next cron minute.
 *
 * Same `FOR UPDATE SKIP LOCKED` claim, narrowed to one lead -- so the drain and this can
 * race safely: whichever claims it first runs it, the other sees nothing to do.
 * =====================================================================
 */
export async function claimLeadDelivery(
  db: Database,
  args: { leadId: number; workerId: string },
): Promise<VoiceJob | null> {
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE voice_jobs
       SET status     = 'claimed',
           claimed_at = now(),
           claimed_by = ${args.workerId},
           attempts   = attempts + 1
     WHERE id = (
       SELECT id
         FROM voice_jobs
        WHERE status = 'pending'
          AND kind = 'deliver_lead'
          AND lead_id = ${args.leadId}
          AND run_after <= now()
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
       AND status = 'pending'
    RETURNING id
  `)
  const id = (rows as unknown as Array<{ id: number }>)[0]?.id
  if (id === undefined) return null

  // Re-selected through Drizzle: raw RETURNING gives snake_case, so `job.leadId`
  // would silently be undefined. Same reasoning as claimNextVoiceJob.
  const [row] = await db.select().from(voiceJobs).where(eq(voiceJobs.id, id))
  return row ?? null
}

export async function completeVoiceJob(db: Database, jobId: number): Promise<void> {
  await db
    .update(voiceJobs)
    .set({ status: 'done', lastError: null, claimedAt: null, claimedBy: null })
    .where(eq(voiceJobs.id, jobId))
}

/**
 * Fail a job: reschedule with backoff, or give up and keep the row.
 *
 * The row is never deleted. A `failed` job with its error is the only record that
 * a recording could not be fetched or a lead could not be delivered -- and the
 * site dashboard reads it, because a lead captured perfectly and never delivered
 * is a lost lead.
 */
export async function failVoiceJob(
  db: Database,
  job: VoiceJob,
  error: string,
): Promise<{ retrying: boolean }> {
  const message = error.slice(0, 2000)
  if (job.attempts >= MAX_ATTEMPTS) {
    await db
      .update(voiceJobs)
      .set({ status: 'failed', lastError: message, claimedAt: null, claimedBy: null })
      .where(eq(voiceJobs.id, job.id))
    return { retrying: false }
  }
  const delay = backoffSeconds(job.attempts)
  await db
    .update(voiceJobs)
    .set({
      status: 'pending',
      lastError: message,
      claimedAt: null,
      claimedBy: null,
      runAfter: sql`now() + (${delay} || ' seconds')::interval`,
    })
    .where(eq(voiceJobs.id, job.id))
  return { retrying: true }
}

/**
 * Return jobs stuck in `claimed` to `pending`.
 *
 * A worker can die mid-download. Without this the job stays claimed forever and
 * the recording never arrives, with nothing on screen indicating anything is
 * wrong -- which is the failure mode this codebase is organised against.
 */
export async function redriveStuckVoiceJobs(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_JOB_MINUTES * 60_000)
  const rows = await db
    .update(voiceJobs)
    .set({ status: 'pending', claimedAt: null, claimedBy: null })
    .where(
      and(eq(voiceJobs.status, 'claimed'), isNotNull(voiceJobs.claimedAt), lt(voiceJobs.claimedAt, cutoff)),
    )
    .returning({ id: voiceJobs.id })
  return rows.length
}

export interface VoiceQueueHealth {
  pending: number
  claimed: number
  failed: number
  /** Jobs that exhausted their retries, newest first. Shown in the UI. */
  failures: Array<{ id: number; kind: string; callId: number | null; lastError: string | null }>
}

export async function getVoiceQueueHealth(db: Database): Promise<VoiceQueueHealth> {
  const [counts] = await db
    .select({
      pending: sql<number>`count(*) FILTER (WHERE status = 'pending')::int`,
      claimed: sql<number>`count(*) FILTER (WHERE status = 'claimed')::int`,
      failed: sql<number>`count(*) FILTER (WHERE status = 'failed')::int`,
    })
    .from(voiceJobs)

  const failures = await db
    .select({
      id: voiceJobs.id,
      kind: voiceJobs.kind,
      callId: voiceJobs.callId,
      lastError: voiceJobs.lastError,
    })
    .from(voiceJobs)
    .where(eq(voiceJobs.status, 'failed'))
    .orderBy(sql`${voiceJobs.id} DESC`)
    .limit(20)

  return {
    pending: counts?.pending ?? 0,
    claimed: counts?.claimed ?? 0,
    failed: counts?.failed ?? 0,
    failures: failures.map((f) => ({ ...f, kind: f.kind as string })),
  }
}
