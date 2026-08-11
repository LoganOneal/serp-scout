import 'server-only'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { closeRate, type CloseRateStats, type LeadDisposition } from '@rnr/core'
import type { Database } from '../db.js'
import { leadOutcomes, leads, type LeadOutcome } from '../schema.js'

/**
 * Lead outcomes -- the revenue half of the loop.
 *
 * The research side predicts rent from estimated volume times a prior. This is the only
 * place a real dollar figure enters the system, so it is what can eventually say
 * whether `valuePerSearchMicros` is right.
 */

export interface RecordOutcomeArgs {
  leadId: number
  disposition: LeadDisposition
  jobValueMicros?: bigint | null
  notes?: string | null
  recordedBy?: string | null
}

/**
 * Upsert the current disposition for a lead.
 *
 * Updated in place rather than appended: the question the dashboard asks is "what
 * happened to this lead", singular. `recorded_at` moves forward on each edit so a
 * correction is visibly recent.
 */
export async function recordLeadOutcome(
  db: Database,
  args: RecordOutcomeArgs,
): Promise<LeadOutcome> {
  const values = {
    leadId: args.leadId,
    disposition: args.disposition,
    jobValueMicros: args.jobValueMicros ?? null,
    notes: args.notes?.trim() || null,
    recordedBy: args.recordedBy?.trim() || null,
    recordedAt: new Date(),
  }

  const [row] = await db
    .insert(leadOutcomes)
    .values(values)
    .onConflictDoUpdate({ target: leadOutcomes.leadId, set: values })
    .returning()

  return row!
}

/** Remove an outcome, returning the lead to "not followed up" rather than to "lost". */
export async function clearLeadOutcome(db: Database, leadId: number): Promise<void> {
  await db.delete(leadOutcomes).where(eq(leadOutcomes.leadId, leadId))
}

export async function listOutcomesForSite(
  db: Database,
  siteId: number,
): Promise<Map<number, LeadOutcome>> {
  const rows = await db
    .select({ outcome: leadOutcomes })
    .from(leadOutcomes)
    .innerJoin(leads, eq(leadOutcomes.leadId, leads.id))
    .where(eq(leads.siteId, siteId))
    .orderBy(desc(leadOutcomes.recordedAt))

  return new Map(rows.map((r) => [r.outcome.leadId, r.outcome]))
}

export interface SiteRealisedValue extends CloseRateStats {
  /**
   * Realised value in the window, scaled to a month, micros.
   *
   * NULL when nothing was recorded -- explicitly not 0, because a site with no recorded
   * outcomes has an UNKNOWN realised value, and rendering that as $0 beside a modelled
   * rent would read as a failed prediction rather than an unmeasured one.
   */
  monthlyValueMicros: bigint | null
  windowDays: number
}

/**
 * Close rate and realised monthly value for a site.
 *
 * The leads denominator counts every lead in the window, including those with no
 * outcome row, so `coverage` is honest about how much of the picture is filled in.
 */
export async function getSiteRealisedValue(
  db: Database,
  siteId: number,
  days = 30,
): Promise<SiteRealisedValue> {
  const since = sql`now() - (${days} || ' days')::interval`

  const [leadRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.siteId, siteId), gte(leads.createdAt, since as never)))

  const rows = await db
    .select({
      leadId: leadOutcomes.leadId,
      disposition: leadOutcomes.disposition,
      jobValueMicros: leadOutcomes.jobValueMicros,
    })
    .from(leadOutcomes)
    .innerJoin(leads, eq(leadOutcomes.leadId, leads.id))
    .where(and(eq(leads.siteId, siteId), gte(leads.createdAt, since as never)))

  const stats = closeRate({
    leadCount: leadRow?.n ?? 0,
    outcomes: rows.map((r) => ({
      leadId: r.leadId,
      disposition: r.disposition,
      jobValueMicros: r.jobValueMicros,
    })),
  })

  /**
   * Scaled to a month with integer arithmetic, so money never touches a float.
   *
   * Null rather than zero when nothing has been recorded -- see the field comment.
   */
  const monthlyValueMicros =
    stats.recorded === 0
      ? null
      : (stats.valueMicros * 30n) / BigInt(Math.max(1, days))

  return { ...stats, monthlyValueMicros, windowDays: days }
}
