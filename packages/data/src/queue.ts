import 'server-only'
import { and, eq, lt, or, sql } from 'drizzle-orm'
import type { Database } from './db.js'
import { scanRuns, type ScanRun, type ScanRunStatus } from './schema.js'

/**
 * The job queue. It is the `scan_runs` table and nothing else.
 *
 * ==================== WHY NO REDIS ====================
 * The previous build had a web action that inserted a `pending` row AND a
 * separate queue helper that enqueued a BullMQ job -- but nothing that connected
 * them. The dispatcher was never written. So the button appeared to work, the row
 * sat pending forever, and no error was raised anywhere: a queue you forget to
 * poll is indistinguishable from a queue with nothing in it.
 *
 * With Postgres as the only queue, there is no second system to forget. The web
 * action's INSERT is itself the enqueue, and `claimNextRun` is the only consumer.
 * The bug class is removed rather than guarded against.
 * ======================================================
 */

/** PRIOR. A claimed run untouched for this long is presumed dead and re-driven. */
export const STUCK_RUN_MINUTES = 20

/**
 * Atomically claim the oldest pending run.
 *
 * `FOR UPDATE SKIP LOCKED` inside the subquery is what makes concurrent workers
 * safe: two workers racing here take two DIFFERENT rows rather than both taking
 * the same one, and neither blocks waiting for the other. The conditional
 * `status = 'pending'` in the outer WHERE closes the remaining window.
 */
export async function claimNextRun(db: Database, workerId: string): Promise<ScanRun | null> {
  // Returns only the id, then re-selects through Drizzle.
  //
  // WHY NOT `RETURNING *`: raw execute() hands back the driver's own row shape,
  // which is snake_case -- so `run.localityId` and `run.budgetCapMicros` would
  // silently be `undefined` and the worker would scan locality NaN with no cap.
  // Nothing would throw at the boundary; it would fail later and elsewhere.
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE scan_runs
       SET status      = 'claimed',
           claimed_at  = now(),
           claimed_by  = ${workerId}
     WHERE id = (
       SELECT id
         FROM scan_runs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
       AND status = 'pending'
    RETURNING id
  `)
  const id = (rows as unknown as Array<{ id: number }>)[0]?.id
  if (id === undefined) return null

  const [row] = await db.select().from(scanRuns).where(eq(scanRuns.id, id))
  return row ?? null
}

/**
 * Return runs stuck in `claimed`/`running` to `pending`.
 *
 * A worker can die mid-scan -- crash, redeploy, laptop closed. Without this the
 * run stays claimed forever and the operator sees a spinner that never resolves,
 * with no indication anything is wrong. Called on worker startup and on every
 * poll tick.
 */
export async function redriveStuckRuns(db: Database): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE scan_runs
       SET status     = 'pending',
           claimed_at = NULL,
           claimed_by = NULL,
           error      = COALESCE(error, '') ||
                        'Re-driven after being stuck in ' || status ||
                        ' for over ${sql.raw(String(STUCK_RUN_MINUTES))} minutes. '
     WHERE status IN ('claimed', 'running')
       AND claimed_at < now() - interval '${sql.raw(String(STUCK_RUN_MINUTES))} minutes'
    RETURNING id
  `)
  return (rows as unknown as { id: number }[]).length
}

/** Enqueue. The INSERT IS the enqueue -- there is nothing else to notify. */
export async function enqueueScan(
  db: Database,
  args: { localityId: number; budgetCapMicros: bigint; usedFixtures: boolean },
): Promise<ScanRun> {
  const [row] = await db
    .insert(scanRuns)
    .values({
      localityId: args.localityId,
      status: 'pending',
      budgetCapMicros: args.budgetCapMicros,
      usedFixtures: args.usedFixtures,
    })
    .returning()
  return row!
}

export async function markRunStatus(
  db: Database,
  runId: number,
  status: ScanRunStatus,
  extra: { error?: string | null; nicheCount?: number } = {},
): Promise<void> {
  const patch: Record<string, unknown> = { status }
  if (status === 'running') patch['startedAt'] = new Date()
  if (status === 'done' || status === 'failed' || status === 'budget_exceeded') {
    patch['finishedAt'] = new Date()
  }
  if (extra.error !== undefined) patch['error'] = extra.error
  if (extra.nicheCount !== undefined) patch['nicheCount'] = extra.nicheCount
  await db.update(scanRuns).set(patch).where(eq(scanRuns.id, runId))
}

/** Heartbeat, so `redriveStuckRuns` measures inactivity rather than total duration. */
export async function touchRun(db: Database, runId: number): Promise<void> {
  await db.update(scanRuns).set({ claimedAt: new Date() }).where(eq(scanRuns.id, runId))
}

export async function findExistingActiveRun(
  db: Database,
  localityId: number,
): Promise<ScanRun | null> {
  const rows = await db
    .select()
    .from(scanRuns)
    .where(
      and(
        eq(scanRuns.localityId, localityId),
        or(
          eq(scanRuns.status, 'pending'),
          eq(scanRuns.status, 'claimed'),
          eq(scanRuns.status, 'running'),
        ),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

export async function countPending(db: Database): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scanRuns)
    .where(eq(scanRuns.status, 'pending'))
  return rows[0]?.n ?? 0
}

/** Diagnostic for the UI: runs stuck long enough that the next tick will re-drive them. */
export async function listStuckRuns(db: Database): Promise<ScanRun[]> {
  const cutoff = new Date(Date.now() - STUCK_RUN_MINUTES * 60_000)
  return db
    .select()
    .from(scanRuns)
    .where(
      and(
        or(eq(scanRuns.status, 'claimed'), eq(scanRuns.status, 'running')),
        lt(scanRuns.claimedAt, cutoff),
      ),
    )
}
