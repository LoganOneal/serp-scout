import 'server-only'
import { eq, sql } from 'drizzle-orm'
import type { Micros } from '@rnr/core'
import type { Database } from '../db.js'
import { discoveryRuns, spendLedger } from '../schema.js'

/**
 * Discovery spend reservation — DB-authoritative, concurrent-safe.
 *
 * Do NOT use BudgetGuard here: it is process-local and hard-wires scan_runs.
 *
 * Under fixtures, costMicros MUST be 0n; we still insert a ledger row so e2e
 * can prove the path ran (runTotal === ledgerTotal === 0n).
 */

export type ReserveDiscoveryResult = 'ok' | 'budget_exceeded' | 'run_terminal'

export async function reserveDiscoverySpend(
  db: Database,
  args: {
    runId: number
    costMicros: Micros
    endpoint: string
    note: string
    jobId?: number
  },
): Promise<ReserveDiscoveryResult> {
  const cost = args.costMicros

  return db.transaction(async (tx) => {
    const locked = await tx.execute<{
      status: string
      spend_micros: string
      budget_cap_micros: string
    }>(sql`
      SELECT status, spend_micros::text, budget_cap_micros::text
        FROM discovery_runs
       WHERE id = ${args.runId}
       FOR UPDATE
    `)
    const row = (locked as unknown as Array<{
      status: string
      spend_micros: string
      budget_cap_micros: string
    }>)[0]
    if (!row) return 'run_terminal'
    if (row.status !== 'pending' && row.status !== 'running') return 'run_terminal'

    const spend = BigInt(row.spend_micros)
    const cap = BigInt(row.budget_cap_micros)

    if (cost > 0n && spend + cost > cap) return 'budget_exceeded'

    if (cost > 0n) {
      const updated = await tx.execute(sql`
        UPDATE discovery_runs
           SET spend_micros = spend_micros + ${cost}
         WHERE id = ${args.runId}
           AND status IN ('pending', 'running')
           AND spend_micros + ${cost} <= budget_cap_micros
         RETURNING id
      `)
      if ((updated as unknown as unknown[]).length === 0) {
        // Race: another worker spent the last cents, or status flipped.
        const again = await tx
          .select({ status: discoveryRuns.status })
          .from(discoveryRuns)
          .where(eq(discoveryRuns.id, args.runId))
        const st = again[0]?.status
        if (st !== 'pending' && st !== 'running') return 'run_terminal'
        return 'budget_exceeded'
      }
    }

    await tx.insert(spendLedger).values({
      discoveryRunId: args.runId,
      endpoint: args.endpoint,
      costMicros: cost,
      note:
        args.note +
        (args.jobId !== undefined ? ` job=${args.jobId}` : '') +
        (cost === 0n ? ' (fixture -- no charge)' : ''),
    })

    return 'ok'
  })
}

/**
 * Credit back a reserved amount when a job is requeued after a retriable failure
 * (timeout/abort) so retries do not inflate spend_micros forever.
 */
export async function refundDiscoverySpend(
  db: Database,
  args: {
    runId: number
    costMicros: Micros
    endpoint: string
    note: string
    jobId?: number
  },
): Promise<void> {
  const cost = args.costMicros
  if (cost <= 0n) return

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE discovery_runs
         SET spend_micros = GREATEST(0, spend_micros - ${cost})
       WHERE id = ${args.runId}
    `)
    await tx.insert(spendLedger).values({
      discoveryRunId: args.runId,
      endpoint: args.endpoint,
      costMicros: -cost,
      note:
        `refund: ${args.note}` +
        (args.jobId !== undefined ? ` job=${args.jobId}` : ''),
    })
  })
}

/**
 * Record spend that has ALREADY happened, with no cap check.
 *
 * ==================== WHY NOT reserveDiscoverySpend ====================
 * Reserve exists to refuse a purchase that would breach the cap -- it answers
 * "may I spend this?". The secondary calls a discovery job makes (keyword
 * volume, maps) are billed the moment they return, so by the time we know they
 * succeeded the only honest thing left to do is write it down. Refusing here
 * would not un-spend the money, it would just hide it again, which is exactly
 * the bug that let a $3.76 run report $0.16.
 *
 * The cap still bites on the next reserve() -- spend_micros has grown, so the
 * run stops early rather than silently overrunning.
 * ====================================================================
 */
export async function recordDiscoverySpend(
  db: Database,
  args: {
    runId: number
    costMicros: Micros
    endpoint: string
    note: string
    jobId?: number
  },
): Promise<void> {
  const cost = args.costMicros
  if (cost <= 0n) return

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE discovery_runs
         SET spend_micros = spend_micros + ${cost}
       WHERE id = ${args.runId}
    `)
    await tx.insert(spendLedger).values({
      discoveryRunId: args.runId,
      endpoint: args.endpoint,
      costMicros: cost,
      note: args.note + (args.jobId !== undefined ? ` job=${args.jobId}` : ''),
    })
  })
}

export async function reconcileDiscoverySpend(
  db: Database,
  runId: number,
): Promise<{ runTotal: Micros; ledgerTotal: Micros; matches: boolean; lineItems: number }> {
  const [run] = await db
    .select({ spendMicros: discoveryRuns.spendMicros })
    .from(discoveryRuns)
    .where(eq(discoveryRuns.id, runId))
  const rows = await db
    .select({
      total: sql<string>`COALESCE(SUM(${spendLedger.costMicros}), 0)::text`,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(spendLedger)
    .where(eq(spendLedger.discoveryRunId, runId))

  const runTotal = run?.spendMicros ?? 0n
  const ledgerTotal = BigInt(rows[0]?.total ?? '0')
  return {
    runTotal,
    ledgerTotal,
    matches: runTotal === ledgerTotal,
    lineItems: rows[0]?.n ?? 0,
  }
}
