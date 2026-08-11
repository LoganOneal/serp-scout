import 'server-only'
import { eq, sql } from 'drizzle-orm'
import type { Micros } from '@rnr/core'
import { formatMicrosUsd } from '@rnr/core'
import type { Database } from './db.js'
import { scanRuns, spendLedger } from './schema.js'
import { BudgetExceededError } from './providers/dataforseo/errors.js'

/**
 * Per-run spend cap, enforced BEFORE each purchase.
 *
 * Checking after the fact is not a cap, it is a report. And every increment is
 * integer micros in a bigint column: a float32 running total drifts below
 * ~$1,024 and freezes entirely above it, at which point the cap silently stops
 * capping while money continues to leave the account.
 *
 * Every purchase also writes a spend_ledger row, so the run total can be
 * reconciled against its line items rather than merely trusted.
 */
export class BudgetGuard {
  private spent: Micros

  constructor(
    private readonly db: Database,
    private readonly runId: number,
    private readonly capMicros: Micros,
    startingSpend: Micros = 0n,
  ) {
    this.spent = startingSpend
  }

  get spentMicros(): Micros {
    return this.spent
  }

  get remainingMicros(): Micros {
    const left = this.capMicros - this.spent
    return left > 0n ? left : 0n
  }

  /** Throws BudgetExceededError if this purchase would breach the cap. */
  assertCanSpend(estimateMicros: Micros): void {
    if (estimateMicros <= 0n) return
    if (this.spent + estimateMicros > this.capMicros) {
      throw new BudgetExceededError(this.spent, this.capMicros, estimateMicros)
    }
  }

  /** Record an actual charge. Atomic increment so concurrent writers cannot lose one. */
  async record(args: {
    endpoint: string
    costMicros: Micros
    rows?: number
    note?: string
  }): Promise<void> {
    if (args.costMicros === 0n) {
      // Still ledgered: a run of all-zero rows is the proof the e2e needs that
      // fixtures were used, rather than an absence of evidence.
      await this.db.insert(spendLedger).values({
        scanRunId: this.runId,
        endpoint: args.endpoint,
        costMicros: 0n,
        rows: args.rows ?? null,
        note: args.note ?? 'fixture -- no charge',
      })
      return
    }
    this.spent += args.costMicros
    await this.db.transaction(async (tx) => {
      await tx.insert(spendLedger).values({
        scanRunId: this.runId,
        endpoint: args.endpoint,
        costMicros: args.costMicros,
        rows: args.rows ?? null,
        note: args.note ?? null,
      })
      await tx
        .update(scanRuns)
        .set({ spendMicros: sql`${scanRuns.spendMicros} + ${args.costMicros}` })
        .where(eq(scanRuns.id, this.runId))
    })
  }

  describe(): string {
    return `${formatMicrosUsd(this.spent)} of ${formatMicrosUsd(this.capMicros)}`
  }
}

/** Reconcile a run's total against its ledger. Used by the e2e and the UI. */
export async function reconcileSpend(
  db: Database,
  runId: number,
): Promise<{ runTotal: Micros; ledgerTotal: Micros; matches: boolean; lineItems: number }> {
  const [run] = await db
    .select({ spendMicros: scanRuns.spendMicros })
    .from(scanRuns)
    .where(eq(scanRuns.id, runId))
  const rows = await db
    .select({
      total: sql<string>`COALESCE(SUM(${spendLedger.costMicros}), 0)::text`,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(spendLedger)
    .where(eq(spendLedger.scanRunId, runId))

  const runTotal = run?.spendMicros ?? 0n
  const ledgerTotal = BigInt(rows[0]?.total ?? '0')
  return {
    runTotal,
    ledgerTotal,
    matches: runTotal === ledgerTotal,
    lineItems: rows[0]?.n ?? 0,
  }
}
